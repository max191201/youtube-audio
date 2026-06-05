const ENABLE_MESSAGE = 'enable-youtube-audio';
const AUDIO_URL_PARAMETERS_TO_REMOVE = ['range', 'rn', 'rbuf', 'ump'];
const AUDIO_ITAGS = ['251', '140', '250', '249', '141', '139', '600', '599'];
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  androidSdkVersion: 35,
};
const VIDEO_RETRY_DELAY_MS = 250;
const MAX_VIDEO_RETRY_ATTEMPTS = 12;
const PLAYER_RESPONSE_RETRY_DELAY_MS = 500;
const MAX_PLAYER_RESPONSE_RETRY_ATTEMPTS = 20;
const AUDIO_URL_GUARD_INTERVAL_MS = 500;
const MAX_AUDIO_URL_GUARD_ATTEMPTS = 24;
let isExtensionEnabled = false;
let playerScriptURL = '';
let signatureDecipherOperations = null;
let playerScriptFetchPromise = null;
let activeAudioURL = '';
let audioURLGuardTimer = null;
const androidPlayerResponsePromises = new Map();

chrome.runtime.sendMessage(ENABLE_MESSAGE, function (response) {
  if (chrome.runtime.lastError) {
    return;
  }

  isExtensionEnabled = !!response && response.enabled === true;

  if (isExtensionEnabled) {
    applyPlayerResponseAudio(0);
  }
});

function removeURLParameters(url, parameters) {
  parameters.forEach(function (parameter) {
    var urlparts = url.split('?');
    if (urlparts.length >= 2) {
      var prefix = encodeURIComponent(parameter) + '=';
      var pars = urlparts[1].split(/[&;]/g);

      for (var i = pars.length; i-- > 0; ) {
        if (pars[i].lastIndexOf(prefix, 0) !== -1) {
          pars.splice(i, 1);
        }
      }

      url = urlparts[0] + '?' + pars.join('&');
    }
  });
  return url;
}

function getYouTubeVideoId() {
  try {
    var url = new URL(location.href);
    var watchVideoId = url.searchParams.get('v');
    if (watchVideoId) {
      return watchVideoId;
    }

    var shortMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shortMatch) {
      return shortMatch[1];
    }

    var embedMatch = url.pathname.match(/^\/embed\/([^/?#]+)/);
    if (embedMatch) {
      return embedMatch[1];
    }
  } catch (_error) {
    return '';
  }

  return '';
}

function getYTCfgValue(name) {
  var pageWindow = window.wrappedJSObject;
  if (pageWindow && pageWindow.ytcfg) {
    try {
      if (typeof pageWindow.ytcfg.get === 'function') {
        var value = pageWindow.ytcfg.get(name);
        if (value) {
          return value;
        }
      }
    } catch (_error) {
      // Continue to script parsing fallback.
    }

    try {
      if (pageWindow.ytcfg.data_ && pageWindow.ytcfg.data_[name]) {
        return pageWindow.ytcfg.data_[name];
      }
    } catch (_error) {
      // Continue to script parsing fallback.
    }
  }

  var scripts = document.getElementsByTagName('script');
  var pattern = new RegExp('"' + name + '"\\s*:\\s*"([^"]+)"');
  for (var i = 0; i < scripts.length; i++) {
    var match = (scripts[i].textContent || '').match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return '';
}

function extractJSONObjectAfterMarker(scriptText, marker) {
  var markerIndex = scriptText.indexOf(marker);
  if (markerIndex === -1) {
    return '';
  }

  var startIndex = scriptText.indexOf('{', markerIndex);
  if (startIndex === -1) {
    return '';
  }

  var depth = 0;
  var inString = false;
  var escaped = false;

  for (var i = startIndex; i < scriptText.length; i++) {
    var character = scriptText[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) {
        return scriptText.slice(startIndex, i + 1);
      }
    }
  }

  return '';
}

function getAdaptiveFormats(playerResponse) {
  var streamingData = playerResponse && playerResponse.streamingData;
  return (streamingData && streamingData.adaptiveFormats) || [];
}

function clonePlayerResponse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return null;
  }
}

function parseWrappedPlayerResponse() {
  var pageWindow = window.wrappedJSObject;
  if (!pageWindow) {
    return null;
  }

  var directResponse = clonePlayerResponse(pageWindow.ytInitialPlayerResponse);
  if (directResponse) {
    return directResponse;
  }

  var rawPlayerResponse =
    pageWindow.ytplayer &&
    pageWindow.ytplayer.config &&
    pageWindow.ytplayer.config.args &&
    pageWindow.ytplayer.config.args.raw_player_response;

  if (!rawPlayerResponse) {
    return null;
  }

  if (typeof rawPlayerResponse === 'string') {
    try {
      return JSON.parse(rawPlayerResponse);
    } catch (_error) {
      return null;
    }
  }

  return clonePlayerResponse(rawPlayerResponse);
}

function parseInitialPlayerResponse() {
  var wrappedPlayerResponse = parseWrappedPlayerResponse();
  if (getAdaptiveFormats(wrappedPlayerResponse).length > 0) {
    return wrappedPlayerResponse;
  }

  var scripts = document.getElementsByTagName('script');
  var fallbackPlayerResponse = wrappedPlayerResponse || null;
  for (var i = 0; i < scripts.length; i++) {
    var scriptText = scripts[i].textContent || '';
    if (scriptText.indexOf('ytInitialPlayerResponse') === -1) {
      continue;
    }

    var jsonText = extractJSONObjectAfterMarker(scriptText, 'ytInitialPlayerResponse');
    if (!jsonText) {
      continue;
    }

    try {
      var playerResponse = JSON.parse(jsonText);
      if (!fallbackPlayerResponse) {
        fallbackPlayerResponse = playerResponse;
      }

      if (getAdaptiveFormats(playerResponse).length > 0) {
        return playerResponse;
      }
    } catch (_error) {
      continue;
    }
  }

  return fallbackPlayerResponse;
}

function isLivePlayerResponse(playerResponse) {
  var videoDetails = playerResponse && playerResponse.videoDetails;
  var playabilityStatus = playerResponse && playerResponse.playabilityStatus;

  return !!(
    (videoDetails && (videoDetails.isLive || videoDetails.isLiveContent)) ||
    (playabilityStatus && playabilityStatus.liveStreamability)
  );
}

function fetchAndroidPlayerResponse(videoId) {
  if (!videoId) {
    return Promise.resolve(null);
  }

  if (androidPlayerResponsePromises.has(videoId)) {
    return androidPlayerResponsePromises.get(videoId);
  }

  var apiKey = getYTCfgValue('INNERTUBE_API_KEY');
  if (!apiKey) {
    return Promise.resolve(null);
  }

  var request = fetch(
    'https://www.youtube.com/youtubei/v1/player?key=' + encodeURIComponent(apiKey),
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        context: {
          client: {
            hl: getYTCfgValue('HL') || 'en',
            gl: getYTCfgValue('GL') || 'US',
            clientName: ANDROID_CLIENT.clientName,
            clientVersion: ANDROID_CLIENT.clientVersion,
            androidSdkVersion: ANDROID_CLIENT.androidSdkVersion,
          },
        },
        videoId: videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    }
  )
    .then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }

      return response.json();
    })
    .catch(function () {
      return null;
    });

  androidPlayerResponsePromises.set(videoId, request);
  return request;
}

function normalizePlayerScriptURL(url) {
  if (!url) {
    return '';
  }

  try {
    return new URL(url, location.origin).href;
  } catch (_error) {
    return '';
  }
}

function findPlayerScriptURLInText(text) {
  var patterns = [
    /"jsUrl"\s*:\s*"([^"]+base\.js)"/,
    /"PLAYER_JS_URL"\s*:\s*"([^"]+base\.js)"/,
    /ytplayer\.config\s*=\s*\{[\s\S]*?"js"\s*:\s*"([^"]+base\.js)"/,
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i]);
    if (match && match[1]) {
      return normalizePlayerScriptURL(match[1].replace(/\\\//g, '/'));
    }
  }

  return '';
}

function getPlayerScriptURL() {
  if (playerScriptURL) {
    return playerScriptURL;
  }

  var scripts = document.getElementsByTagName('script');
  for (var i = 0; i < scripts.length; i++) {
    var src = normalizePlayerScriptURL(scripts[i].src);
    if (src && src.indexOf('/s/player/') !== -1 && src.indexOf('/base.js') !== -1) {
      playerScriptURL = src;
      return playerScriptURL;
    }
  }

  for (var j = 0; j < scripts.length; j++) {
    playerScriptURL = findPlayerScriptURLInText(scripts[j].textContent || '');
    if (playerScriptURL) {
      return playerScriptURL;
    }
  }

  return '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFunctionBody(playerScript, functionName) {
  var patterns = [
    new RegExp('function\\s+' + escapeRegExp(functionName) + '\\s*\\(([^)]*)\\)\\s*\\{'),
    new RegExp(
      '(?:(?:var|let|const)\\s+)?' +
        escapeRegExp(functionName) +
        '\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{'
    ),
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = patterns[i].exec(playerScript);
    if (!match) {
      continue;
    }

    var bodyStart = match.index + match[0].length;
    var depth = 1;
    var inString = false;
    var quote = '';
    var escaped = false;

    for (var j = bodyStart; j < playerScript.length; j++) {
      var character = playerScript[j];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          inString = false;
        }
        continue;
      }

      if (character === '"' || character === "'") {
        inString = true;
        quote = character;
      } else if (character === '{') {
        depth++;
      } else if (character === '}') {
        depth--;
        if (depth === 0) {
          return playerScript.slice(bodyStart, j);
        }
      }
    }
  }

  return '';
}

function findSignatureFunction(playerScript) {
  var functionPatterns = [
    /(?:^|[;,{])\s*function\s+([\w$]+)\s*\(\w\)\s*\{\w=\w\.split\((?:""|'')\);[\s\S]{0,800}?return\s+\w\.join\((?:""|'')\)\}/g,
    /(?:^|[;,{])\s*(?:(?:var|let|const)\s+)?([\w$]+)\s*=\s*function\s*\(\w\)\s*\{\w=\w\.split\((?:""|'')\);[\s\S]{0,800}?return\s+\w\.join\((?:""|'')\)\}/g,
  ];

  for (var i = 0; i < functionPatterns.length; i++) {
    var match;
    while ((match = functionPatterns[i].exec(playerScript)) !== null) {
      var functionName = match[1];
      var body = getFunctionBody(playerScript, functionName);
      if (body && /\.split\((?:""|'')\)/.test(body) && /\.join\((?:""|'')\)/.test(body)) {
        return {
          name: functionName,
          body: body,
        };
      }
    }
  }

  return null;
}

function getObjectLiteralBody(playerScript, objectName) {
  var pattern = new RegExp(
    '(?:(?:var|let|const)\\s+)?' + escapeRegExp(objectName) + '\\s*=\\s*\\{',
    'g'
  );
  var match = pattern.exec(playerScript);
  if (!match) {
    return '';
  }

  var bodyStart = match.index + match[0].length;
  var depth = 1;
  var inString = false;
  var quote = '';
  var escaped = false;

  for (var i = bodyStart; i < playerScript.length; i++) {
    var character = playerScript[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        inString = false;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      inString = true;
      quote = character;
    } else if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) {
        return playerScript.slice(bodyStart, i);
      }
    }
  }

  return '';
}

function getHelperMethodType(helperBody, methodName) {
  var patterns = [
    new RegExp(
      '(?:^|,)' + escapeRegExp(methodName) + '\\s*:\\s*function\\s*\\(([^)]*)\\)\\s*\\{([^}]+)\\}'
    ),
    new RegExp(
      '(?:^|,)"' + escapeRegExp(methodName) + '"\\s*:\\s*function\\s*\\(([^)]*)\\)\\s*\\{([^}]+)\\}'
    ),
    new RegExp('(?:^|,)' + escapeRegExp(methodName) + '\\s*\\(([^)]*)\\)\\s*\\{([^}]+)\\}'),
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = helperBody.match(patterns[i]);
    if (!match) {
      continue;
    }

    var body = match[2];
    if (body.indexOf('.reverse(') !== -1) {
      return 'reverse';
    }
    if (body.indexOf('.splice(') !== -1) {
      return 'splice';
    }
    if (body.indexOf('.slice(') !== -1) {
      return 'slice';
    }
    if (body.indexOf('%') !== -1 && body.indexOf('[0]') !== -1) {
      return 'swap';
    }
  }

  return '';
}

function extractSignatureDecipherOperations(playerScript) {
  var signatureFunction = findSignatureFunction(playerScript);
  if (!signatureFunction) {
    return null;
  }

  var operationCalls = [];
  var callPattern = /([\w$]+)\.([\w$]+)\(\w(?:,(\d+))?\)/g;
  var callMatch;
  while ((callMatch = callPattern.exec(signatureFunction.body)) !== null) {
    operationCalls.push({
      objectName: callMatch[1],
      methodName: callMatch[2],
      argument: callMatch[3] ? parseInt(callMatch[3], 10) : 0,
    });
  }

  if (operationCalls.length === 0) {
    return null;
  }

  var helperBody = getObjectLiteralBody(playerScript, operationCalls[0].objectName);
  if (!helperBody) {
    return null;
  }

  var operations = [];
  for (var i = 0; i < operationCalls.length; i++) {
    var call = operationCalls[i];
    var type = getHelperMethodType(helperBody, call.methodName);
    if (!type) {
      return null;
    }

    operations.push({
      type: type,
      argument: call.argument,
    });
  }

  return operations;
}

function decipherSignature(signature, operations) {
  var characters = signature.split('');

  for (var i = 0; i < operations.length; i++) {
    var operation = operations[i];
    if (operation.type === 'reverse') {
      characters.reverse();
    } else if (operation.type === 'splice') {
      characters.splice(0, operation.argument);
    } else if (operation.type === 'slice') {
      characters = characters.slice(operation.argument);
    } else if (operation.type === 'swap') {
      var index = operation.argument % characters.length;
      var first = characters[0];
      characters[0] = characters[index];
      characters[index] = first;
    }
  }

  return characters.join('');
}

function loadSignatureDecipherOperations() {
  if (signatureDecipherOperations) {
    return Promise.resolve(signatureDecipherOperations);
  }

  if (playerScriptFetchPromise) {
    return playerScriptFetchPromise;
  }

  var scriptURL = getPlayerScriptURL();
  if (!scriptURL) {
    return Promise.resolve(null);
  }

  playerScriptFetchPromise = fetch(scriptURL)
    .then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.text();
    })
    .then(function (playerScript) {
      signatureDecipherOperations = extractSignatureDecipherOperations(playerScript);
      if (!signatureDecipherOperations) {
        return null;
      }

      return signatureDecipherOperations;
    })
    .catch(function () {
      return null;
    });

  return playerScriptFetchPromise;
}

function isAudioFormat(format) {
  var mimeType = format.mimeType || '';
  var itag = String(format.itag || '');

  return (
    mimeType.indexOf('audio/') === 0 || !!format.audioQuality || AUDIO_ITAGS.indexOf(itag) !== -1
  );
}

function getFormatRank(format) {
  var itag = String(format.itag || '');
  var priorityIndex = AUDIO_ITAGS.indexOf(itag);
  if (priorityIndex !== -1) {
    return priorityIndex;
  }

  return AUDIO_ITAGS.length;
}

function getAudioFormatURL(format, operations) {
  if (format.url) {
    return removeURLParameters(format.url, AUDIO_URL_PARAMETERS_TO_REMOVE);
  }

  var cipher = format.signatureCipher || format.cipher;
  if (!cipher || !operations) {
    return '';
  }

  var cipherParameters = new URLSearchParams(cipher);
  var url = cipherParameters.get('url');
  if (!url) {
    return '';
  }

  var signature = cipherParameters.get('sig') || cipherParameters.get('signature');
  var encryptedSignature = cipherParameters.get('s');
  var signatureParameterName = cipherParameters.get('sp') || 'signature';

  if (!signature && encryptedSignature) {
    signature = decipherSignature(encryptedSignature, operations);
  }

  if (signature) {
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    url =
      url +
      separator +
      encodeURIComponent(signatureParameterName) +
      '=' +
      encodeURIComponent(signature);
  }

  return removeURLParameters(url, AUDIO_URL_PARAMETERS_TO_REMOVE);
}

function sortAudioFormats(left, right) {
  var rankDifference = getFormatRank(left) - getFormatRank(right);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  return (right.audioBitrate || 0) - (left.audioBitrate || 0);
}

function selectAudioURLFromPlayerResponse(playerResponse) {
  var streamingData = playerResponse && playerResponse.streamingData;
  var adaptiveFormats = streamingData && streamingData.adaptiveFormats;
  if (!adaptiveFormats || adaptiveFormats.length === 0) {
    return Promise.resolve('');
  }

  var audioFormats = adaptiveFormats.filter(isAudioFormat);
  var directAudioFormats = audioFormats.filter(function (format) {
    return !!format.url;
  });

  if (directAudioFormats.length > 0) {
    directAudioFormats.sort(sortAudioFormats);
    return Promise.resolve(getAudioFormatURL(directAudioFormats[0], null));
  }

  var cipherAudioFormats = audioFormats.filter(function (format) {
    return !!(format.signatureCipher || format.cipher);
  });

  if (cipherAudioFormats.length === 0) {
    return Promise.resolve('');
  }

  cipherAudioFormats.sort(sortAudioFormats);

  return loadSignatureDecipherOperations().then(function (operations) {
    if (!operations) {
      return '';
    }

    for (var i = 0; i < cipherAudioFormats.length; i++) {
      var audioURL = getAudioFormatURL(cipherAudioFormats[i], operations);
      if (audioURL) {
        return audioURL;
      }
    }

    return '';
  });
}

function selectAudioURLForCurrentPage(playerResponse) {
  return selectAudioURLFromPlayerResponse(playerResponse).then(function (audioURL) {
    if (audioURL || isLivePlayerResponse(playerResponse)) {
      return audioURL;
    }

    var videoId = getYouTubeVideoId();
    if (!videoId) {
      return '';
    }

    return fetchAndroidPlayerResponse(videoId).then(function (androidPlayerResponse) {
      return selectAudioURLFromPlayerResponse(androidPlayerResponse);
    });
  });
}

function applyPlayerResponseAudio(attempt) {
  if (!isExtensionEnabled) {
    return;
  }

  var playerResponse = parseInitialPlayerResponse();
  selectAudioURLForCurrentPage(playerResponse).then(function (audioURL) {
    if (audioURL) {
      handleAudioMessage({ url: audioURL });
      return;
    }

    if (attempt < MAX_PLAYER_RESPONSE_RETRY_ATTEMPTS) {
      setTimeout(function () {
        applyPlayerResponseAudio(attempt + 1);
      }, PLAYER_RESPONSE_RETRY_DELAY_MS);
    }
  });
}

document.addEventListener('yt-navigate-finish', function () {
  if (!isExtensionEnabled) {
    return;
  }
  applyPlayerResponseAudio(0);
});

var makeSetAudioURL = function (videoElement, url) {
  if (videoElement.src != url) {
    var paused = videoElement.paused;
    videoElement.src = url;
    if (paused === false) {
      var playResult = videoElement.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(function () {
          return;
        });
      }
    }
  }
};

function findVideoElement() {
  return (
    document.querySelector('video.html5-main-video') || document.getElementsByTagName('video')[0]
  );
}

function stopAudioURLGuard() {
  if (audioURLGuardTimer) {
    clearInterval(audioURLGuardTimer);
    audioURLGuardTimer = null;
  }
}

function startAudioURLGuard(url) {
  stopAudioURLGuard();

  var attempts = 0;
  audioURLGuardTimer = setInterval(function () {
    attempts++;

    if (!activeAudioURL || activeAudioURL !== url || attempts > MAX_AUDIO_URL_GUARD_ATTEMPTS) {
      stopAudioURLGuard();
      return;
    }

    var videoElement = findVideoElement();
    if (videoElement && videoElement.src != url) {
      makeSetAudioURL(videoElement, url);
    }
  }, AUDIO_URL_GUARD_INTERVAL_MS);
}

function removeAudioOnlyNotifications() {
  let audioOnlyDivs = document.getElementsByClassName('audio_only_div');
  for (var i = audioOnlyDivs.length - 1; i >= 0; i--) {
    var div = audioOnlyDivs[i];
    div.parentNode.removeChild(div);
  }
}

function appendAudioOnlyNotification(videoElement) {
  let parent = videoElement.closest('#movie_player');
  if (!parent && videoElement.parentNode) {
    parent = videoElement.parentNode.parentNode || videoElement.parentNode;
  }

  if (!parent || parent.getElementsByClassName('audio_only_div').length > 0) {
    return;
  }

  let extensionAlert = document.createElement('div');
  extensionAlert.className = 'audio_only_div';

  let alertText = document.createElement('p');
  alertText.className = 'alert_text';
  alertText.innerHTML =
    'Youtube Audio Extension is running. It disables the video stream and uses only the audio stream' +
    ' which saves battery life and bandwidth / data when you just want to listen to just songs. If you want to watch' +
    ' video also, click on the extension icon and refresh your page.';

  extensionAlert.appendChild(alertText);

  chrome.storage.local.get('disable_video_text', function (values) {
    var disableVideoText = values.disable_video_text ? true : false;
    if (!disableVideoText && parent.getElementsByClassName('audio_only_div').length == 0) {
      parent.appendChild(extensionAlert);
    }
  });
}

function handleAudioMessage(request, attempt) {
  attempt = attempt || 0;
  let url = request.url;

  if (url == '') {
    activeAudioURL = '';
    stopAudioURLGuard();
    removeAudioOnlyNotifications();
    return;
  }

  let videoElement = findVideoElement();
  if (!videoElement) {
    if (attempt < MAX_VIDEO_RETRY_ATTEMPTS) {
      setTimeout(function () {
        handleAudioMessage(request, attempt + 1);
      }, VIDEO_RETRY_DELAY_MS);
    }
    return;
  }

  videoElement.onloadeddata = function () {
    makeSetAudioURL(videoElement, url);
  };
  activeAudioURL = url;
  makeSetAudioURL(videoElement, url);
  startAudioURLGuard(url);

  let audioOnlyDivs = document.getElementsByClassName('audio_only_div');
  if (audioOnlyDivs.length == 0 && url.includes('mime=audio')) {
    appendAudioOnlyNotification(videoElement);
  }
}

chrome.runtime.onMessage.addListener(function (request, _sender, _sendResponse) {
  if (!request || typeof request.url !== 'string') {
    return;
  }

  handleAudioMessage(request);
});
