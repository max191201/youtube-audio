const tabIds = new Set();
const AUDIO_URL_PARAMETERS_TO_REMOVE = ['range', 'rn', 'rbuf', 'ump'];
const ENABLE_MESSAGE = 'enable-youtube-audio';
const AUDIO_ITAGS = new Set(['139', '140', '141', '249', '250', '251', '599', '600']);
let isExtensionEnabled;

function getURLParameters(url) {
  try {
    return new URL(url).searchParams;
  } catch (_error) {
    var queryIndex = url.indexOf('?');
    if (queryIndex === -1) {
      return new URLSearchParams();
    }

    return new URLSearchParams(url.slice(queryIndex + 1));
  }
}

function getDecodedParameter(parameters, name) {
  var value = parameters.get(name);
  if (!value) {
    return '';
  }

  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function isLiveRequest(parameters) {
  return parameters.get('live') === '1';
}

function isAudioMediaRequest(parameters) {
  var mime = getDecodedParameter(parameters, 'mime');
  var itag = parameters.get('itag');

  return mime.indexOf('audio') === 0 || AUDIO_ITAGS.has(itag);
}

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

function reloadTab() {
  for (const tabId of tabIds) {
    chrome.tabs.get(tabId, function (tab) {
      if (tab.active) {
        chrome.tabs.reload(tabId);
        return;
      }
    });
  }
}

function processRequest(details) {
  var parameters = getURLParameters(details.url);

  if (!isAudioMediaRequest(parameters) || isLiveRequest(parameters) || details.tabId < 0) {
    return;
  }

  var audioURL = removeURLParameters(details.url, AUDIO_URL_PARAMETERS_TO_REMOVE);
  chrome.tabs.sendMessage(details.tabId, { url: audioURL }, function () {
    if (chrome.runtime.lastError) {
      return;
    }
  });
}

function enableExtension() {
  isExtensionEnabled = true;
  chrome.browserAction.setIcon({
    path: {
      128: 'img/icon128.png',
      38: 'img/icon38.png',
    },
  });
  chrome.webRequest.onBeforeRequest.addListener(processRequest, { urls: ['<all_urls>'] }, [
    'blocking',
  ]);
}

function disableExtension() {
  isExtensionEnabled = false;
  chrome.browserAction.setIcon({
    path: {
      38: 'img/disabled_icon38.png',
    },
  });
  chrome.webRequest.onBeforeRequest.removeListener(processRequest);
}

function saveSettings(currentState) {
  chrome.storage.local.set({ youtube_audio_state: currentState });
}

chrome.browserAction.onClicked.addListener(function () {
  chrome.storage.local.get('youtube_audio_state', function (values) {
    var currentState = values.youtube_audio_state;
    var newState = !currentState;

    if (newState) {
      enableExtension();
    } else {
      disableExtension();
    }

    saveSettings(newState);
    reloadTab();
  });
});

chrome.storage.local.get('youtube_audio_state', function (values) {
  var currentState = values.youtube_audio_state;
  if (typeof currentState === 'undefined') {
    currentState = true;
    saveSettings(currentState);
  }

  if (currentState) {
    enableExtension();
  } else {
    disableExtension();
  }
});

function getCurrentExtensionState(callback) {
  if (typeof isExtensionEnabled !== 'undefined') {
    callback(isExtensionEnabled);
    return;
  }

  chrome.storage.local.get('youtube_audio_state', function (values) {
    var currentState = values.youtube_audio_state;
    if (typeof currentState === 'undefined') {
      currentState = true;
    }

    callback(currentState);
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message !== ENABLE_MESSAGE) {
    return;
  }

  if (!sender.tab || typeof sender.tab.id === 'undefined') {
    sendResponse({ enabled: false });
    return;
  }

  tabIds.add(sender.tab.id);
  getCurrentExtensionState(function (enabled) {
    sendResponse({ enabled: enabled });
  });

  return true;
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  tabIds.delete(tabId);
});
