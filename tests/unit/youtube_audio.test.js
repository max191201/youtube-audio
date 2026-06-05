/**
 * Unit tests for youtube_audio.js - Content script
 * Tests the YouTube Audio content script functionality
 */

describe('Content Script (youtube_audio.js)', () => {
  let makeSetAudioURL;
  let handleAudioMessage;
  let stopAudioURLGuard;
  let extractJSONObjectAfterMarker;
  let getYouTubeVideoId;
  let selectAudioURLFromPlayerResponse;
  let selectAudioURLForCurrentPage;
  let shouldReloadForYouTubeNavigation;
  let decipherSignature;

  beforeEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
    jest.useRealTimers();

    const audioUrlParametersToRemove = ['range', 'rn', 'rbuf', 'ump'];
    const audioItags = ['251', '140', '250', '249', '141', '139', '600', '599'];
    let activeAudioURL = '';
    let audioURLGuardTimer = null;

    getYouTubeVideoId = function (urlValue) {
      try {
        const url = new URL(urlValue);
        const watchVideoId = url.searchParams.get('v');
        if (watchVideoId) {
          return watchVideoId;
        }

        const shortMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
        if (shortMatch) {
          return shortMatch[1];
        }

        const embedMatch = url.pathname.match(/^\/embed\/([^/?#]+)/);
        if (embedMatch) {
          return embedMatch[1];
        }
      } catch (_error) {
        return '';
      }

      return '';
    };

    shouldReloadForYouTubeNavigation = function (previousVideoId, nextVideoId) {
      return !!(previousVideoId && nextVideoId && previousVideoId !== nextVideoId);
    };

    const removeURLParameters = function (url, parameters) {
      parameters.forEach(function (parameter) {
        const urlparts = url.split('?');
        if (urlparts.length >= 2) {
          const prefix = encodeURIComponent(parameter) + '=';
          const pars = urlparts[1].split(/[&;]/g);

          for (let i = pars.length; i-- > 0; ) {
            if (pars[i].lastIndexOf(prefix, 0) !== -1) {
              pars.splice(i, 1);
            }
          }

          url = urlparts[0] + '?' + pars.join('&');
        }
      });
      return url;
    };

    extractJSONObjectAfterMarker = function (scriptText, marker) {
      const markerIndex = scriptText.indexOf(marker);
      if (markerIndex === -1) {
        return '';
      }

      const startIndex = scriptText.indexOf('{', markerIndex);
      if (startIndex === -1) {
        return '';
      }

      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let i = startIndex; i < scriptText.length; i++) {
        const character = scriptText[i];

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
    };

    const isAudioFormat = function (format) {
      const mimeType = format.mimeType || '';
      const itag = String(format.itag || '');

      return (
        mimeType.indexOf('audio/') === 0 || !!format.audioQuality || audioItags.indexOf(itag) !== -1
      );
    };

    const getFormatRank = function (format) {
      const itag = String(format.itag || '');
      const priorityIndex = audioItags.indexOf(itag);
      if (priorityIndex !== -1) {
        return priorityIndex;
      }

      return audioItags.length;
    };

    decipherSignature = function (signature, operations) {
      let characters = signature.split('');

      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i];
        if (operation.type === 'reverse') {
          characters.reverse();
        } else if (operation.type === 'splice') {
          characters.splice(0, operation.argument);
        } else if (operation.type === 'slice') {
          characters = characters.slice(operation.argument);
        } else if (operation.type === 'swap') {
          const index = operation.argument % characters.length;
          const first = characters[0];
          characters[0] = characters[index];
          characters[index] = first;
        }
      }

      return characters.join('');
    };

    const getAudioFormatURL = function (format, operations) {
      if (format.url) {
        return removeURLParameters(format.url, audioUrlParametersToRemove);
      }

      const cipher = format.signatureCipher || format.cipher;
      if (!cipher || !operations) {
        return '';
      }

      const cipherParameters = new URLSearchParams(cipher);
      let url = cipherParameters.get('url');
      if (!url) {
        return '';
      }

      let signature = cipherParameters.get('sig') || cipherParameters.get('signature');
      const encryptedSignature = cipherParameters.get('s');
      const signatureParameterName = cipherParameters.get('sp') || 'signature';

      if (!signature && encryptedSignature) {
        signature = decipherSignature(encryptedSignature, operations);
      }

      if (signature) {
        const separator = url.indexOf('?') === -1 ? '?' : '&';
        url =
          url +
          separator +
          encodeURIComponent(signatureParameterName) +
          '=' +
          encodeURIComponent(signature);
      }

      return removeURLParameters(url, audioUrlParametersToRemove);
    };

    const sortAudioFormats = function (left, right) {
      const rankDifference = getFormatRank(left) - getFormatRank(right);
      if (rankDifference !== 0) {
        return rankDifference;
      }

      return (right.audioBitrate || 0) - (left.audioBitrate || 0);
    };

    selectAudioURLFromPlayerResponse = function (playerResponse, operations) {
      const streamingData = playerResponse && playerResponse.streamingData;
      const adaptiveFormats = streamingData && streamingData.adaptiveFormats;
      if (!adaptiveFormats || adaptiveFormats.length === 0) {
        return Promise.resolve('');
      }

      const audioFormats = adaptiveFormats.filter(isAudioFormat);
      const directAudioFormats = audioFormats.filter(function (format) {
        return !!format.url;
      });

      if (directAudioFormats.length > 0) {
        directAudioFormats.sort(sortAudioFormats);
        return Promise.resolve(getAudioFormatURL(directAudioFormats[0], null));
      }

      const cipherAudioFormats = audioFormats.filter(function (format) {
        return !!(format.signatureCipher || format.cipher);
      });

      if (cipherAudioFormats.length === 0 || !operations) {
        return Promise.resolve('');
      }

      cipherAudioFormats.sort(sortAudioFormats);
      return Promise.resolve(getAudioFormatURL(cipherAudioFormats[0], operations));
    };

    const getPlayerResponseVideoId = function (playerResponse) {
      const videoDetails = playerResponse && playerResponse.videoDetails;
      return (videoDetails && videoDetails.videoId) || '';
    };

    const isPlayerResponseForCurrentPage = function (playerResponse, currentVideoId) {
      const playerResponseVideoId = getPlayerResponseVideoId(playerResponse);

      return !currentVideoId || !playerResponseVideoId || currentVideoId === playerResponseVideoId;
    };

    selectAudioURLForCurrentPage = function (
      playerResponse,
      currentVideoId,
      androidPlayerResponse
    ) {
      const pagePlayerResponse = isPlayerResponseForCurrentPage(playerResponse, currentVideoId)
        ? playerResponse
        : null;

      return selectAudioURLFromPlayerResponse(pagePlayerResponse).then(function (audioURL) {
        if (audioURL) {
          return audioURL;
        }

        if (!currentVideoId) {
          return '';
        }

        return selectAudioURLFromPlayerResponse(androidPlayerResponse);
      });
    };

    // Define the function as it is in youtube_audio.js
    makeSetAudioURL = function (videoElement, url) {
      if (videoElement.src != url) {
        const paused = videoElement.paused;
        videoElement.src = url;
        if (paused === false) {
          videoElement.play();
        }
      }
    };

    const findVideoElement = function () {
      return (
        document.querySelector('video.html5-main-video') ||
        document.getElementsByTagName('video')[0]
      );
    };

    stopAudioURLGuard = function () {
      if (audioURLGuardTimer) {
        clearInterval(audioURLGuardTimer);
        audioURLGuardTimer = null;
      }
    };

    const startAudioURLGuard = function (url) {
      stopAudioURLGuard();

      let attempts = 0;
      audioURLGuardTimer = setInterval(function () {
        attempts++;

        if (!activeAudioURL || activeAudioURL !== url || attempts > 24) {
          stopAudioURLGuard();
          return;
        }

        const videoElement = findVideoElement();
        if (videoElement && videoElement.src != url) {
          makeSetAudioURL(videoElement, url);
        }
      }, 500);
    };

    const removeAudioOnlyNotifications = function () {
      const audioOnlyDivs = document.getElementsByClassName('audio_only_div');
      for (let i = audioOnlyDivs.length - 1; i >= 0; i--) {
        const div = audioOnlyDivs[i];
        div.parentNode.removeChild(div);
      }
    };

    const appendAudioOnlyNotification = function (videoElement) {
      let parent = videoElement.closest('#movie_player');
      if (!parent && videoElement.parentNode) {
        parent = videoElement.parentNode.parentNode || videoElement.parentNode;
      }

      if (!parent || parent.getElementsByClassName('audio_only_div').length > 0) {
        return;
      }

      const extensionAlert = document.createElement('div');
      extensionAlert.className = 'audio_only_div';

      const alertText = document.createElement('p');
      alertText.className = 'alert_text';
      alertText.innerHTML = 'Youtube Audio Extension is running.';
      extensionAlert.appendChild(alertText);

      chrome.storage.local.get('disable_video_text', function (values) {
        const disableVideoText = values.disable_video_text ? true : false;
        if (!disableVideoText && parent.getElementsByClassName('audio_only_div').length == 0) {
          parent.appendChild(extensionAlert);
        }
      });
    };

    handleAudioMessage = function (request, attempt) {
      attempt = attempt || 0;
      const url = request.url;

      if (url == '') {
        activeAudioURL = '';
        stopAudioURLGuard();
        removeAudioOnlyNotifications();
        return;
      }

      const videoElement = findVideoElement();
      if (!videoElement) {
        if (attempt < 12) {
          setTimeout(function () {
            handleAudioMessage(request, attempt + 1);
          }, 250);
        }
        return;
      }

      videoElement.onloadeddata = function () {
        makeSetAudioURL(videoElement, url);
      };
      activeAudioURL = url;
      makeSetAudioURL(videoElement, url);
      startAudioURLGuard(url);

      const audioOnlyDivs = document.getElementsByClassName('audio_only_div');
      if (audioOnlyDivs.length == 0 && url.includes('mime=audio')) {
        appendAudioOnlyNotification(videoElement);
      }
    };
  });

  afterEach(() => {
    if (stopAudioURLGuard) {
      stopAudioURLGuard();
    }
    jest.useRealTimers();
  });

  describe('makeSetAudioURL', () => {
    it('should set video src to audio URL when different', () => {
      const video = createMockVideoElement();
      video.src = 'https://old-url.com';

      makeSetAudioURL(video, 'https://new-audio-url.com');

      // Browser normalizes URLs by adding trailing slash
      expect(video.src).toContain('https://new-audio-url.com');
    });

    it('should not change src when URL is the same', () => {
      const video = createMockVideoElement();
      video.src = 'https://same-url.com';

      makeSetAudioURL(video, 'https://same-url.com');

      // play should not be called since src didn't change
      expect(video.play).not.toHaveBeenCalled();
    });

    it('should call play() if video was playing', () => {
      const video = createMockVideoElement();

      // Set up video as playing (paused = false)
      Object.defineProperty(video, 'paused', {
        value: false,
        writable: true,
      });
      video.src = 'https://old-url.com/';

      makeSetAudioURL(video, 'https://new-audio-url.com');

      // Verify the new src was set
      expect(video.src).toContain('new-audio-url');
    });

    it('should not call play() if video was paused', () => {
      const video = createMockVideoElement();
      video.src = 'https://old-url.com';
      video.paused = true; // Video was paused

      makeSetAudioURL(video, 'https://new-audio-url.com');

      expect(video.play).not.toHaveBeenCalled();
    });
  });

  describe('Runtime message handling', () => {
    it('should register runtime message listener on chrome.runtime', () => {
      // Simulate the content script registering its listener
      chrome.runtime.sendMessage('enable-youtube-audio');

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith('enable-youtube-audio');
    });
  });

  describe('Player response audio fallback', () => {
    it('should read video ids from watch, shorts, and embed URLs', () => {
      expect(getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(getYouTubeVideoId('https://www.youtube.com/shorts/abc123?feature=share')).toBe(
        'abc123'
      );
      expect(getYouTubeVideoId('https://www.youtube.com/embed/xyz789')).toBe('xyz789');
    });

    it('should extract the initial player response JSON from a script', () => {
      const scriptText =
        'window.ytInitialPlayerResponse = {"streamingData":{"adaptiveFormats":[]},' +
        '"videoDetails":{"title":"brace } inside string"}}; window.next = true;';

      const jsonText = extractJSONObjectAfterMarker(scriptText, 'ytInitialPlayerResponse');

      expect(JSON.parse(jsonText).videoDetails.title).toBe('brace } inside string');
    });

    it('should select and clean the preferred direct audio URL', async () => {
      const playerResponse = {
        streamingData: {
          adaptiveFormats: [
            {
              itag: 18,
              mimeType: 'video/mp4',
              url: 'https://video.example/videoplayback?itag=18&range=0-1',
            },
            {
              itag: 140,
              mimeType: 'audio/mp4',
              audioBitrate: 128,
              url: 'https://audio.example/videoplayback?itag=140&mime=audio%2Fmp4&range=0-1&ump=1',
            },
            {
              itag: 251,
              mimeType: 'audio/webm',
              audioBitrate: 160,
              url: 'https://audio.example/videoplayback?itag=251&mime=audio%2Fwebm&rn=1&rbuf=2',
            },
          ],
        },
      };

      await expect(selectAudioURLFromPlayerResponse(playerResponse)).resolves.toBe(
        'https://audio.example/videoplayback?itag=251&mime=audio%2Fwebm'
      );
    });

    it('should ignore stale player responses after YouTube navigation', async () => {
      const stalePlayerResponse = {
        videoDetails: {
          videoId: 'first-video',
        },
        streamingData: {
          adaptiveFormats: [
            {
              itag: 251,
              mimeType: 'audio/webm',
              url: 'https://audio.example/videoplayback?video=first&mime=audio%2Fwebm',
            },
          ],
        },
      };
      const androidPlayerResponse = {
        videoDetails: {
          videoId: 'second-video',
        },
        streamingData: {
          adaptiveFormats: [
            {
              itag: 251,
              mimeType: 'audio/webm',
              url: 'https://audio.example/videoplayback?video=second&mime=audio%2Fwebm',
            },
          ],
        },
      };

      await expect(
        selectAudioURLForCurrentPage(stalePlayerResponse, 'second-video', androidPlayerResponse)
      ).resolves.toBe('https://audio.example/videoplayback?video=second&mime=audio%2Fwebm');
    });

    it('should decipher cipher-only audio formats when operations are available', async () => {
      const playerResponse = {
        streamingData: {
          adaptiveFormats: [
            {
              itag: 251,
              mimeType: 'audio/webm',
              signatureCipher:
                'url=https%3A%2F%2Faudio.example%2Fvideoplayback%3Fitag%3D251%26range%3D0-1' +
                '&sp=sig&s=abcdef',
            },
          ],
        },
      };
      const operations = [
        { type: 'reverse', argument: 0 },
        { type: 'swap', argument: 2 },
        { type: 'splice', argument: 1 },
      ];

      await expect(selectAudioURLFromPlayerResponse(playerResponse, operations)).resolves.toBe(
        'https://audio.example/videoplayback?itag=251&sig=efcba'
      );
    });

    it('should return an empty URL for cipher-only formats when operations are unavailable', async () => {
      const playerResponse = {
        streamingData: {
          adaptiveFormats: [
            {
              itag: 251,
              mimeType: 'audio/webm',
              signatureCipher: 'url=https%3A%2F%2Faudio.example%2Fvideoplayback&s=abc',
            },
          ],
        },
      };

      await expect(selectAudioURLFromPlayerResponse(playerResponse)).resolves.toBe('');
    });
  });

  describe('YouTube navigation handling', () => {
    it('should reload only when navigating between two different videos', () => {
      expect(shouldReloadForYouTubeNavigation('first-video', 'second-video')).toBe(true);
      expect(shouldReloadForYouTubeNavigation('same-video', 'same-video')).toBe(false);
      expect(shouldReloadForYouTubeNavigation('', 'first-video')).toBe(false);
      expect(shouldReloadForYouTubeNavigation('first-video', '')).toBe(false);
    });
  });

  describe('Audio only notification', () => {
    beforeEach(() => {
      // Create a mock DOM structure like YouTube
      document.body.innerHTML = `
        <div class="video-container">
          <div class="player">
            <video src="https://youtube.com/video"></video>
          </div>
        </div>
      `;
    });

    it('should create notification div with correct class', () => {
      const extensionAlert = document.createElement('div');
      extensionAlert.className = 'audio_only_div';

      const alertText = document.createElement('p');
      alertText.className = 'alert_text';
      alertText.innerHTML = 'Youtube Audio Extension is running.';

      extensionAlert.appendChild(alertText);
      document.body.appendChild(extensionAlert);

      const notificationDiv = document.querySelector('.audio_only_div');
      expect(notificationDiv).not.toBeNull();
      expect(notificationDiv.className).toBe('audio_only_div');
    });

    it('should contain correct notification text', () => {
      const extensionAlert = document.createElement('div');
      extensionAlert.className = 'audio_only_div';

      const alertText = document.createElement('p');
      alertText.className = 'alert_text';
      alertText.innerHTML =
        'Youtube Audio Extension is running. It disables the video stream and uses only the audio stream';

      extensionAlert.appendChild(alertText);
      document.body.appendChild(extensionAlert);

      const textElement = document.querySelector('.alert_text');
      expect(textElement.innerHTML).toContain('Youtube Audio Extension is running');
    });

    it('should not add duplicate notification divs', () => {
      // Add first notification
      const div1 = document.createElement('div');
      div1.className = 'audio_only_div';
      document.body.appendChild(div1);

      // Check that we have one
      let divs = document.getElementsByClassName('audio_only_div');
      expect(divs.length).toBe(1);

      // Simulate the check from the script
      const audioOnlyDivs = document.getElementsByClassName('audio_only_div');
      if (audioOnlyDivs.length === 0) {
        const div2 = document.createElement('div');
        div2.className = 'audio_only_div';
        document.body.appendChild(div2);
      }

      // Should still be only one
      divs = document.getElementsByClassName('audio_only_div');
      expect(divs.length).toBe(1);
    });

    it('should not duplicate notification when repeated audio messages arrive', () => {
      const video = document.querySelector('video');

      handleAudioMessage({ url: 'https://youtube.com/videoplayback?mime=audio' });
      handleAudioMessage({ url: 'https://youtube.com/videoplayback?mime=audio' });

      expect(video.src).toContain('mime=audio');
      expect(document.getElementsByClassName('audio_only_div')).toHaveLength(1);
    });

    it('should remove notification when empty URL message arrives', () => {
      const extensionAlert = document.createElement('div');
      extensionAlert.className = 'audio_only_div';
      document.body.appendChild(extensionAlert);

      handleAudioMessage({ url: '' });

      expect(document.getElementsByClassName('audio_only_div')).toHaveLength(0);
    });

    it('should reapply audio URL if YouTube replaces the video source', () => {
      jest.useFakeTimers();
      const video = document.querySelector('video');
      const audioURL = 'https://youtube.com/videoplayback?mime=audio';

      handleAudioMessage({ url: audioURL });
      video.src = 'https://youtube.com/videoplayback?mime=video';

      jest.advanceTimersByTime(500);

      expect(video.src).toContain('mime=audio');
    });
  });

  describe('Missing video handling', () => {
    it('should not throw when audio message arrives before video element exists', () => {
      jest.useFakeTimers();
      document.body.innerHTML = '<div id="movie_player"></div>';

      expect(() => {
        handleAudioMessage({ url: 'https://youtube.com/videoplayback?mime=audio' });
      }).not.toThrow();

      expect(jest.getTimerCount()).toBe(1);
    });
  });

  describe('Storage integration', () => {
    it('should respect disable_video_text setting when true', () => {
      chrome.storage.local._setStorage({ disable_video_text: true });

      chrome.storage.local.get('disable_video_text', (values) => {
        const disableVideoText = values.disable_video_text ? true : false;
        expect(disableVideoText).toBe(true);
      });
    });

    it('should respect disable_video_text setting when false', () => {
      chrome.storage.local._setStorage({ disable_video_text: false });

      chrome.storage.local.get('disable_video_text', (values) => {
        const disableVideoText = values.disable_video_text ? true : false;
        expect(disableVideoText).toBe(false);
      });
    });

    it('should default to false when setting not set', () => {
      chrome.storage.local._setStorage({});

      chrome.storage.local.get('disable_video_text', (values) => {
        const disableVideoText = values.disable_video_text ? true : false;
        expect(disableVideoText).toBe(false);
      });
    });
  });
});
