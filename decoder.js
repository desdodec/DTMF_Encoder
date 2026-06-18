(function () {
  "use strict";

  var ROWS = [697, 770, 852, 941];
  var COLS = [1209, 1336, 1477, 1633];
  var SYMBOL_CADENCE_SECONDS = 0.11;
  var SYMBOLS = {
    "697:1209": "1",
    "697:1336": "2",
    "697:1477": "3",
    "697:1633": "A",
    "770:1209": "4",
    "770:1336": "5",
    "770:1477": "6",
    "770:1633": "B",
    "852:1209": "7",
    "852:1336": "8",
    "852:1477": "9",
    "852:1633": "C",
    "941:1209": "*",
    "941:1336": "0",
    "941:1477": "#",
    "941:1633": "D"
  };

  var audioFileInput = document.getElementById("audioFile");
  var dropZone = document.getElementById("dropZone");
  var fileStatus = document.getElementById("fileStatus");
  var decodeStatus = document.getElementById("decodeStatus");
  var decodeButton = document.getElementById("decodeButton");
  var loadSampleButton = document.getElementById("loadSampleButton");
  var exportJsonButton = document.getElementById("exportJsonButton");
  var windowMsInput = document.getElementById("windowMs");
  var hopMsInput = document.getElementById("hopMs");
  var minToneMsInput = document.getElementById("minToneMs");
  var subjectId = document.getElementById("subjectId");
  var subjectName = document.getElementById("subjectName");
  var subjectTimestamp = document.getElementById("subjectTimestamp");
  var framedPayload = document.getElementById("framedPayload");
  var rawPayload = document.getElementById("rawPayload");
  var durationLabel = document.getElementById("durationLabel");
  var waveformCanvas = document.getElementById("waveformCanvas");
  var toneTableBody = document.getElementById("toneTableBody");
  var toneCount = document.getElementById("toneCount");

  var selectedFile = null;
  var decodedAudio = null;
  var lastResult = null;

  audioFileInput.addEventListener("change", function () {
    if (audioFileInput.files && audioFileInput.files[0]) {
      loadFile(audioFileInput.files[0]);
    }
  });

  audioFileInput.addEventListener("click", function () {
    // Allow Android file providers to return the same recording more than once.
    audioFileInput.value = "";
  });

  ["dragenter", "dragover"].forEach(function (eventName) {
    dropZone.addEventListener(eventName, function (event) {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach(function (eventName) {
    dropZone.addEventListener(eventName, function (event) {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
    });
  });

  dropZone.addEventListener("drop", function (event) {
    var file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
      loadFile(file);
    }
  });

  loadSampleButton.addEventListener("click", loadTestRecording);
  decodeButton.addEventListener("click", decodeSelectedFile);
  exportJsonButton.addEventListener("click", exportJson);
  drawEmptyWaveform();

  function loadFile(file) {
    selectedFile = file;
    decodedAudio = null;
    lastResult = null;
    fileStatus.textContent = file.name + " (" + formatBytes(file.size) + ")";
    decodeStatus.textContent = "Ready to decode";
    decodeButton.disabled = false;
    exportJsonButton.disabled = true;
    resetResult();
    drawEmptyWaveform();
  }

  function loadTestRecording() {
    fileStatus.textContent = "Loading audio/dtfm_test.mp4...";
    window.fetch("audio/dtfm_test.mp4")
      .then(function (response) {
        if (!response.ok) {
          throw new Error("audio/dtfm_test.mp4 was not found.");
        }
        return response.blob();
      })
      .then(function (blob) {
        loadFile(new File([blob], "dtfm_test.mp4", { type: blob.type || "video/mp4" }));
      })
      .catch(function (error) {
        fileStatus.textContent = "No file loaded";
        window.alert(error.message);
      });
  }

  function decodeSelectedFile() {
    if (!selectedFile) {
      return;
    }

    decodeButton.disabled = true;
    decodeStatus.textContent = "Decoding audio...";

    selectedFile.arrayBuffer()
      .then(function (buffer) {
        var AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        var context = new AudioContextConstructor();
        return context.decodeAudioData(buffer).then(function (audioBuffer) {
          return context.close().then(function () {
            return audioBuffer;
          });
        });
      })
      .then(function (audioBuffer) {
        decodedAudio = extractMono(audioBuffer);
        decodeStatus.textContent = "Analyzing DTMF...";
        return waitForPaint().then(function () {
          return decodeAudio(decodedAudio, audioBuffer.sampleRate);
        });
      })
      .then(function (result) {
        lastResult = result;
        renderResult(result);
        exportJsonButton.disabled = false;
        decodeStatus.textContent = "Decode finished";
      })
      .catch(function (error) {
        decodeStatus.textContent = "Decode failed";
        window.alert("Could not decode this audio file: " + error.message);
      })
      .finally(function () {
        decodeButton.disabled = false;
      });
  }

  function extractMono(audioBuffer) {
    var length = audioBuffer.length;
    var mono = new Float32Array(length);
    for (var channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
      var data = audioBuffer.getChannelData(channel);
      for (var index = 0; index < length; index += 1) {
        mono[index] += data[index] / audioBuffer.numberOfChannels;
      }
    }
    return mono;
  }

  function decodeAudio(audio, sampleRate) {
    var windowMs = Number(windowMsInput.value);
    var hopMs = Number(hopMsInput.value);
    var minToneMs = Number(minToneMsInput.value);
    var windowSize = Math.max(1, Math.round(sampleRate * windowMs / 1000));
    var hopSize = Math.max(1, Math.round(sampleRate * hopMs / 1000));
    var minFrames = Math.max(1, Math.ceil(minToneMs / hopMs));
    var classifications = [];
    var windowValues = makeHann(windowSize);

    for (var start = 0; start + windowSize <= audio.length; start += hopSize) {
      var frame = audio.subarray(start, start + windowSize);
      var rms = calculateRms(frame);
      if (rms < 0.01) {
        classifications.push({ start: start, symbol: null, confidence: 0 });
        continue;
      }
      classifications.push(classifyFrame(frame, windowValues, sampleRate, start));
    }

    var tones = flushToneRuns(classifications, minFrames, windowSize, sampleRate);
    var payload = tones.map(function (tone) { return tone.symbol; }).join("");
    var framed = "";
    var decodedRecord = { id: "", name: "", timestamp: "" };
    if (payload.charAt(0) === "*" && payload.indexOf("#", 1) !== -1) {
      var endIndex = payload.indexOf("#", 1);
      framed = payload.slice(0, endIndex + 1);
      decodedRecord = decodeRecordPayload(framed);
    }

    return {
      fileName: selectedFile ? selectedFile.name : "",
      durationSeconds: audio.length / sampleRate,
      sampleRate: sampleRate,
      payload: payload,
      framedPayload: framed,
      subjectId: decodedRecord.id,
      subjectName: decodedRecord.name,
      subjectTimestamp: decodedRecord.timestamp,
      tones: tones
    };
  }

  function decodeRecordPayload(framed) {
    var body = framed.slice(1, -1);
    var nameMarker = body.indexOf("A");
    var timestampMarker = body.indexOf("B", nameMarker + 1);

    if (nameMarker === -1 || timestampMarker === -1) {
      return { id: normalizeSubjectId(body), name: "Not encoded", timestamp: "Not encoded" };
    }

    return {
      id: normalizeSubjectId(body.slice(0, nameMarker)),
      name: decodeName(body.slice(nameMarker + 1, timestampMarker)),
      timestamp: decodeTimestamp(body.slice(timestampMarker + 1))
    };
  }

  function normalizeSubjectId(value) {
    return /^\d+$/.test(value) && value.length < 3 ? value.padStart(3, "0") : value;
  }

  function decodeName(encoded) {
    if (!/^\d+$/.test(encoded) || encoded.length % 2 !== 0) {
      return "";
    }

    var letters = [];
    for (var index = 0; index < encoded.length; index += 2) {
      var code = Number.parseInt(encoded.slice(index, index + 2), 10);
      if (code < 1 || code > 26) {
        return "";
      }
      letters.push(String.fromCharCode(64 + code));
    }
    return letters.join("");
  }

  function decodeTimestamp(encoded) {
    if (!/^\d+$/.test(encoded)) {
      return "";
    }

    var date = new Date(Number.parseInt(encoded, 10));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function classifyFrame(frame, windowValues, sampleRate, start) {
    var rowPowers = ROWS.map(function (freq) {
      return { freq: freq, power: tonePower(frame, windowValues, sampleRate, freq) };
    }).sort(comparePower);
    var colPowers = COLS.map(function (freq) {
      return { freq: freq, power: tonePower(frame, windowValues, sampleRate, freq) };
    }).sort(comparePower);

    var row = rowPowers[0];
    var col = colPowers[0];
    var rowNext = rowPowers[1].power || 1e-12;
    var colNext = colPowers[1].power || 1e-12;
    var signalPower = Math.max(row.power + col.power, 1e-12);
    var totalPower = rowPowers.concat(colPowers).reduce(function (sum, item) {
      return sum + item.power;
    }, 0) || 1e-12;
    var separation = Math.min(row.power / Math.max(rowNext, 1e-12), col.power / Math.max(colNext, 1e-12));
    var dominance = signalPower / totalPower;
    var confidence = Math.min(separation / 4, 1) * dominance;

    if (separation < 2.2 || dominance < 0.45) {
      return { start: start, symbol: null, rowHz: row.freq, colHz: col.freq, confidence: confidence };
    }

    return {
      start: start,
      symbol: SYMBOLS[row.freq + ":" + col.freq],
      rowHz: row.freq,
      colHz: col.freq,
      confidence: confidence
    };
  }

  function tonePower(frame, windowValues, sampleRate, frequency) {
    var real = 0;
    var imag = 0;
    var scale = -2 * Math.PI * frequency / sampleRate;
    for (var index = 0; index < frame.length; index += 1) {
      var sample = frame[index] * windowValues[index];
      var angle = scale * index;
      real += sample * Math.cos(angle);
      imag += sample * Math.sin(angle);
    }
    return real * real + imag * imag;
  }

  function flushToneRuns(classifications, minFrames, windowSize, sampleRate) {
    var tones = [];
    var run = [];
    var symbol = null;

    function flush() {
      if (!symbol || run.length < minFrames) {
        run = [];
        symbol = null;
        return;
      }
      var rowVotes = {};
      var colVotes = {};
      var confidence = 0;
      run.forEach(function (item) {
        rowVotes[item.rowHz] = (rowVotes[item.rowHz] || 0) + 1;
        colVotes[item.colHz] = (colVotes[item.colHz] || 0) + 1;
        confidence += item.confidence;
      });
      var startSeconds = run[0].start / sampleRate;
      var endSeconds = (run[run.length - 1].start + windowSize) / sampleRate;
      var repeatCount = Math.max(1, Math.round((endSeconds - startSeconds) / SYMBOL_CADENCE_SECONDS));
      var segmentSeconds = (endSeconds - startSeconds) / repeatCount;

      for (var repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
        tones.push({
          index: tones.length + 1,
          symbol: symbol,
          startSeconds: startSeconds + repeatIndex * segmentSeconds,
          endSeconds: startSeconds + (repeatIndex + 1) * segmentSeconds,
          rowHz: Number(bestVote(rowVotes)),
          colHz: Number(bestVote(colVotes)),
          confidence: confidence / run.length
        });
      }
      run = [];
      symbol = null;
    }

    classifications.forEach(function (item) {
      if (item.symbol === symbol) {
        if (item.symbol) {
          run.push(item);
        }
        return;
      }
      flush();
      if (item.symbol) {
        symbol = item.symbol;
        run = [item];
      }
    });
    flush();
    return tones;
  }

  function mergeAdjacent(tones) {
    var merged = [];
    tones.forEach(function (tone) {
      var previous = merged[merged.length - 1];
      if (previous && previous.symbol === tone.symbol && tone.startSeconds - previous.endSeconds < 0.04) {
        previous.endSeconds = tone.endSeconds;
        previous.confidence = Math.max(previous.confidence, tone.confidence);
        return;
      }
      tone.index = merged.length + 1;
      merged.push(tone);
    });
    return merged;
  }

  function renderResult(result) {
    subjectId.textContent = result.subjectId || "-";
    subjectName.textContent = result.subjectName || "-";
    subjectTimestamp.textContent = result.subjectTimestamp || "-";
    framedPayload.textContent = result.framedPayload || "-";
    rawPayload.textContent = result.payload || "-";
    durationLabel.textContent = result.durationSeconds.toFixed(2) + "s";
    toneCount.textContent = result.tones.length + " " + (result.tones.length === 1 ? "tone" : "tones");
    renderToneTable(result.tones);
    drawWaveform(decodedAudio, result.sampleRate, result.tones);
  }

  function renderToneTable(tones) {
    toneTableBody.innerHTML = "";
    if (tones.length === 0) {
      toneTableBody.innerHTML = '<tr class="empty-row"><td colspan="6">No tones decoded.</td></tr>';
      return;
    }
    tones.forEach(function (tone) {
      var row = document.createElement("tr");
      row.innerHTML = "<td></td><td></td><td></td><td></td><td></td><td></td>";
      row.children[0].textContent = tone.index;
      row.children[1].textContent = tone.symbol;
      row.children[2].textContent = tone.startSeconds.toFixed(3);
      row.children[3].textContent = tone.endSeconds.toFixed(3);
      row.children[4].textContent = tone.rowHz + " + " + tone.colHz + " Hz";
      row.children[5].textContent = tone.confidence.toFixed(3);
      toneTableBody.appendChild(row);
    });
  }

  function drawWaveform(audio, sampleRate, tones) {
    var ctx = waveformCanvas.getContext("2d");
    var width = waveformCanvas.width;
    var height = waveformCanvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    var mid = height * 0.42;
    ctx.strokeStyle = "#d9e1dc";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    ctx.strokeStyle = "#176c5b";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    var samplesPerPixel = Math.max(1, Math.floor(audio.length / width));
    for (var x = 0; x < width; x += 1) {
      var start = x * samplesPerPixel;
      var end = Math.min(audio.length, start + samplesPerPixel);
      var peak = 0;
      for (var i = start; i < end; i += 1) {
        peak = Math.max(peak, Math.abs(audio[i]));
      }
      var y = peak * (height * 0.35);
      ctx.moveTo(x, mid - y);
      ctx.lineTo(x, mid + y);
    }
    ctx.stroke();

    var duration = audio.length / sampleRate;
    var laneTop = height * 0.72;
    var laneHeight = 44;
    tones.forEach(function (tone) {
      var x1 = tone.startSeconds / duration * width;
      var x2 = tone.endSeconds / duration * width;
      ctx.fillStyle = "#eaf5f1";
      ctx.fillRect(x1, laneTop, Math.max(3, x2 - x1), laneHeight);
      ctx.strokeStyle = "#176c5b";
      ctx.strokeRect(x1, laneTop, Math.max(3, x2 - x1), laneHeight);
      ctx.fillStyle = "#0d4f43";
      ctx.font = "bold 18px Arial";
      ctx.fillText(tone.symbol, x1 + 5, laneTop + 28);
    });
  }

  function drawEmptyWaveform() {
    var ctx = waveformCanvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    ctx.fillStyle = "#5f6c67";
    ctx.font = "18px Arial";
    ctx.fillText("Load an audio file to see the waveform and decoded DTMF timeline.", 24, 52);
  }

  function resetResult() {
    subjectId.textContent = "-";
    subjectName.textContent = "-";
    subjectTimestamp.textContent = "-";
    framedPayload.textContent = "-";
    rawPayload.textContent = "-";
    durationLabel.textContent = "-";
    toneCount.textContent = "0 tones";
    toneTableBody.innerHTML = '<tr class="empty-row"><td colspan="6">No tones decoded yet.</td></tr>';
  }

  function exportJson() {
    if (!lastResult) {
      return;
    }
    var blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "dtmf_decode_" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function waitForPaint() {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        window.setTimeout(resolve, 0);
      });
    });
  }

  function calculateRms(frame) {
    var sum = 0;
    for (var index = 0; index < frame.length; index += 1) {
      sum += frame[index] * frame[index];
    }
    return Math.sqrt(sum / frame.length);
  }

  function makeHann(size) {
    var values = new Float32Array(size);
    for (var index = 0; index < size; index += 1) {
      values[index] = 0.5 * (1 - Math.cos(2 * Math.PI * index / (size - 1)));
    }
    return values;
  }

  function comparePower(a, b) {
    return b.power - a.power;
  }

  function bestVote(votes) {
    return Object.keys(votes).sort(function (a, b) {
      return votes[b] - votes[a];
    })[0];
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return bytes + " B";
    }
    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + " KB";
    }
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
})();
