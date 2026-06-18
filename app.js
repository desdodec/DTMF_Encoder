(function () {
  "use strict";

  var STORAGE_KEY = "cycle-gait-audio-tagger.records";
  var TONE_DURATION_SECONDS = 0.08;
  var GAP_SECONDS = 0.03;
  var MAX_GAIN = 0.25;
  var MAX_PREDICTIONS = 12;
  var DTMF_FREQUENCIES = {
    "1": [697, 1209],
    "2": [697, 1336],
    "3": [697, 1477],
    "A": [697, 1633],
    "4": [770, 1209],
    "5": [770, 1336],
    "6": [770, 1477],
    "B": [770, 1633],
    "7": [852, 1209],
    "8": [852, 1336],
    "9": [852, 1477],
    "C": [852, 1633],
    "*": [941, 1209],
    "0": [941, 1336],
    "#": [941, 1477],
    "D": [941, 1633]
  };

  var audioContext = null;
  var records = loadRecords();
  var contactSettings = loadContactSettings();
  var predictorNames = [];
  var predictorNamesPromise = null;
  var latestRegisteredRecord = records.length > 0 ? records[records.length - 1] : null;

  var form = document.getElementById("registrationForm");
  var firstNameInput = document.getElementById("firstName");
  var validationMessage = document.getElementById("validationMessage");
  var namePredictionList = document.getElementById("namePredictionList");
  var nextSubjectLabel = document.getElementById("nextSubjectLabel");
  var payloadPreview = document.getElementById("payloadPreview");
  var replayToneButton = document.getElementById("replayToneButton");
  var recordCount = document.getElementById("recordCount");
  var recordsTableBody = document.getElementById("recordsTableBody");
  var exportCsvButton = document.getElementById("exportCsvButton");
  var resetDataButton = document.getElementById("resetDataButton");
  var qrStatus = document.getElementById("qrStatus");
  var qrSubjectLabel = document.getElementById("qrSubjectLabel");
  var vcardText = document.getElementById("vcardText");
  var vcardQrCanvas = document.getElementById("vcardQrCanvas");
  var copyVcardButton = document.getElementById("copyVcardButton");

  form.addEventListener("submit", handleRegistrationSubmit);
  firstNameInput.addEventListener("input", function () {
    validationMessage.textContent = "";
    loadPredictorNamesForInput(firstNameInput.value);
    renderPredictions(firstNameInput.value);
  });
  firstNameInput.addEventListener("blur", function () {
    window.setTimeout(hidePredictions, 120);
  });
  replayToneButton.addEventListener("click", replayCurrentTone);
  exportCsvButton.addEventListener("click", exportCsv);
  resetDataButton.addEventListener("click", resetSessionData);
  copyVcardButton.addEventListener("click", copyVcardText);

  render();
  addLog("Application ready for Subject " + getNextId() + ".", false);

  function loadPredictorNamesForInput(value) {
    if (value.trim().length < 2 || predictorNames.length > 0 || predictorNamesPromise) {
      return;
    }

    predictorNamesPromise = loadPredictorNames().then(function () {
      renderPredictions(firstNameInput.value);
    });
  }

  function loadPredictorNames() {
    if (!window.fetch) {
      addLog("Using built-in name suggestions; this browser does not support fetch.", true);
      return Promise.resolve();
    }

    return window.fetch("names.json", { cache: "force-cache" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("names.json request failed");
        }
        return response.json();
      })
      .then(function (payload) {
        predictorNames = Array.isArray(payload.names)
          ? payload.names.map(function (item) { return item.name; }).filter(Boolean)
          : [];
        addLog("Loaded " + predictorNames.length + " predictor names from names.json.", false);
      })
      .catch(function () {
        addLog("Using built-in name suggestions; names.json could not be loaded.", true);
      });
  }

  function handleRegistrationSubmit(event) {
    event.preventDefault();

    var normalizedName = normalizeName(firstNameInput.value);
    if (!normalizedName) {
      validationMessage.textContent = "Enter a first name using letters only.";
      addLog("Registration blocked: empty, spaced, or symbolic input was rejected.", true);
      return;
    }

    var id = getNextId();
    var record = {
      id: id,
      name: normalizedName,
      timestamp: new Date().toISOString()
    };
    var payload = buildPayload(record);

    records.push(record);
    latestRegisteredRecord = record;
    saveRecords(records);

    transmitDtmfPayload(payload)
      .then(function () {
        validationMessage.textContent = "Tone transmitted.";
      })
      .catch(function () {
        validationMessage.textContent = "Audio could not start. Turn off Silent Mode, raise the volume, and tap Replay Tone.";
        addLog("Audio transmission was blocked by the browser.", true);
      });
    firstNameInput.value = "";
    validationMessage.textContent = "";
    render();
    renderVcardQr(record);
    addLog("Saved Subject " + id + " (" + normalizedName + ") and transmitted " + payload + ".", false);
  }

  function replayCurrentTone() {
    if (!latestRegisteredRecord) {
      addLog("Replay blocked: register a subject before replaying a full record tone.", true);
      return;
    }

    var payload = buildPayload(latestRegisteredRecord);
    transmitDtmfPayload(payload)
      .then(function () {
        validationMessage.textContent = "Tone replayed.";
        addLog("Replayed Subject " + latestRegisteredRecord.id + " without saving a subject record.", false);
      })
      .catch(function () {
        validationMessage.textContent = "Audio could not start. Turn off Silent Mode, raise the volume, and tap Replay Tone again.";
        addLog("Replay was blocked by the browser.", true);
      });
  }

  function normalizeName(value) {
    var trimmed = value.trim();
    if (!/^[A-Za-z]+$/.test(trimmed)) {
      return "";
    }
    return trimmed.toUpperCase();
  }

  function renderPredictions(value) {
    var query = value.trim().toUpperCase();
    namePredictionList.innerHTML = "";

    if (query.length < 2 || predictorNames.length === 0) {
      hidePredictions();
      return;
    }

    var matches = predictorNames.filter(function (name) {
      return name.indexOf(query) === 0;
    }).slice(0, MAX_PREDICTIONS);

    if (matches.length === 0) {
      hidePredictions();
      return;
    }

    matches.forEach(function (name) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.setAttribute("role", "option");
      button.addEventListener("click", function () {
        firstNameInput.value = name;
        validationMessage.textContent = "";
        hidePredictions();
        firstNameInput.focus();
      });
      item.appendChild(button);
      namePredictionList.appendChild(item);
    });

    namePredictionList.classList.add("is-visible");
    firstNameInput.setAttribute("aria-expanded", "true");
  }

  function hidePredictions() {
    namePredictionList.classList.remove("is-visible");
    firstNameInput.setAttribute("aria-expanded", "false");
  }

  function getNextId() {
    var highestId = records.reduce(function (highest, record) {
      var numericId = Number.parseInt(record.id, 10);
      if (Number.isNaN(numericId)) {
        return highest;
      }
      return Math.max(highest, numericId);
    }, 0);

    return String(highestId + 1).padStart(3, "0");
  }

  function buildPayload(record) {
    return "*" + record.id + "A" + encodeName(record.name) + "B" + encodeTimestamp(record.timestamp) + "#";
  }

  function encodeName(name) {
    return String(name).split("").map(function (letter) {
      var code = letter.charCodeAt(0) - 64;
      return String(code).padStart(2, "0");
    }).join("");
  }

  function encodeTimestamp(timestamp) {
    var millis = Date.parse(timestamp);
    return Number.isNaN(millis) ? "" : String(millis);
  }

  function transmitDtmfPayload(payload) {
    var context;
    var ready;
    try {
      context = getAudioContext();
      ready = context.state === "running" ? Promise.resolve() : context.resume();
    } catch (error) {
      return Promise.reject(error);
    }

    return Promise.resolve(ready).then(function () {
      if (context.state !== "running") {
        throw new Error("AudioContext did not enter the running state.");
      }

      var startTime = context.currentTime + 0.05;
      Array.from(payload).forEach(function (symbol, index) {
        scheduleDtmfTone(context, symbol, startTime + index * (TONE_DURATION_SECONDS + GAP_SECONDS));
      });
    });
  }

  function getAudioContext() {
    var AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("Web Audio API is not supported in this browser.");
    }

    if (!audioContext) {
      audioContext = new AudioContextConstructor();
    }

    return audioContext;
  }

  function scheduleDtmfTone(context, symbol, startTime) {
    var frequencies = DTMF_FREQUENCIES[symbol];
    if (!frequencies) {
      return;
    }

    var gainNode = context.createGain();
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(MAX_GAIN, startTime + 0.006);
    gainNode.gain.setValueAtTime(MAX_GAIN, startTime + TONE_DURATION_SECONDS - 0.006);
    gainNode.gain.linearRampToValueAtTime(0, startTime + TONE_DURATION_SECONDS);
    gainNode.connect(context.destination);

    frequencies.forEach(function (frequency) {
      var oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, startTime);
      oscillator.connect(gainNode);
      oscillator.start(startTime);
      oscillator.stop(startTime + TONE_DURATION_SECONDS);
    });
  }

  function loadRecords() {
    try {
      var rawRecords = window.localStorage.getItem(STORAGE_KEY);
      if (!rawRecords) {
        return [];
      }

      var parsedRecords = JSON.parse(rawRecords);
      if (!Array.isArray(parsedRecords)) {
        return [];
      }

      return parsedRecords.filter(isValidRecord);
    } catch (error) {
      return [];
    }
  }

  function loadContactSettings() {
    return { name: "Cycle Gait Project", email: "tessellnationstation@gmail.com" };
  }

  function isValidRecord(record) {
    return Boolean(
      record &&
        typeof record.id === "string" &&
        typeof record.name === "string" &&
        typeof record.timestamp === "string"
    );
  }

  function saveRecords(nextRecords) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords));
  }

  function render() {
    var nextId = getNextId();
    nextSubjectLabel.textContent = "Ready for Subject " + nextId;
    payloadPreview.textContent = latestRegisteredRecord ? buildPayload(latestRegisteredRecord) : "Full frame after registration";
    recordCount.textContent = records.length + " saved " + pluralize(records.length, "record", "records");
    renderTable();
    renderVcardQr(latestRegisteredRecord);
  }

  function renderTable() {
    recordsTableBody.innerHTML = "";

    if (records.length === 0) {
      var emptyRow = document.createElement("tr");
      emptyRow.className = "empty-row";
      emptyRow.innerHTML = '<td colspan="3">No subject records saved yet.</td>';
      recordsTableBody.appendChild(emptyRow);
      return;
    }

    records.slice().reverse().forEach(function (record) {
      var row = document.createElement("tr");
      row.appendChild(createCell(record.id));
      row.appendChild(createCell(record.name));
      row.appendChild(createCell(formatTimestamp(record.timestamp)));
      recordsTableBody.appendChild(row);
    });
  }

  function createCell(text) {
    var cell = document.createElement("td");
    cell.textContent = text;
    return cell;
  }

  function addLog(message, isWarning) {
    var statusLog = document.getElementById("statusLog");
    if (!statusLog) {
      return;
    }

    var item = document.createElement("li");
    if (isWarning) {
      item.style.borderLeftColor = "var(--danger)";
    }

    var now = new Date();
    item.innerHTML = "<time datetime=\"" + now.toISOString() + "\">" + formatTimestamp(now.toISOString()) + "</time><span></span>";
    item.querySelector("span").textContent = message;
    statusLog.prepend(item);
  }

  function renderVcardQr(record) {
    clearQrCanvas();

    if (!record) {
      qrStatus.textContent = "Add your contact email, then register a subject.";
      qrSubjectLabel.textContent = "No subject selected";
      vcardText.value = "";
      return;
    }

    var activeContact = getActiveContactSettings();
    if (!isValidEmail(activeContact.email)) {
      qrStatus.textContent = "Save your contact email to generate a vCard QR.";
      qrSubjectLabel.textContent = "Subject " + record.id + " ready for contact QR";
      vcardText.value = "";
      return;
    }

    var vcard = buildVcard(record, activeContact);
    vcardText.value = vcard;
    qrSubjectLabel.textContent = "Subject " + record.id + " contact card";
    qrStatus.textContent = "Ready to scan or photograph.";

    if (typeof window.qrcode !== "function") {
      qrStatus.textContent = "QR library was not loaded; vCard text is available.";
      addLog("QR library unavailable; vCard text fallback is shown.", true);
      return;
    }

    drawQr(vcard);
  }

  function getActiveContactSettings() {
    return {
      name: contactSettings.name || "Cycle Gait Project",
      email: contactSettings.email
    };
  }

  function buildVcard(record, activeContact) {
    var displayName = activeContact.name || "Cycle Gait Project";
    return [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:" + escapeVcardValue(displayName),
      "EMAIL:" + escapeVcardValue(activeContact.email),
      "NOTE:" + escapeVcardValue("Cycle Gait Subject " + record.id),
      "END:VCARD"
    ].join("\r\n");
  }

  function escapeVcardValue(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  }

  function drawQr(text) {
    var qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();

    var context = vcardQrCanvas.getContext("2d");
    var size = vcardQrCanvas.width;
    var moduleCount = qr.getModuleCount();
    var quietModules = 4;
    var tileSize = Math.floor(size / (moduleCount + quietModules * 2));
    var qrSize = tileSize * (moduleCount + quietModules * 2);
    var offset = Math.floor((size - qrSize) / 2);

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#17211d";

    for (var row = 0; row < moduleCount; row += 1) {
      for (var col = 0; col < moduleCount; col += 1) {
        if (qr.isDark(row, col)) {
          context.fillRect(
            offset + (col + quietModules) * tileSize,
            offset + (row + quietModules) * tileSize,
            tileSize,
            tileSize
          );
        }
      }
    }
  }

  function clearQrCanvas() {
    var context = vcardQrCanvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, vcardQrCanvas.width, vcardQrCanvas.height);
  }

  function copyVcardText() {
    if (!vcardText.value) {
      addLog("No vCard text is available to copy yet.", true);
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(vcardText.value)
        .then(function () {
          addLog("Copied vCard text to clipboard.", false);
        })
        .catch(function () {
          fallbackCopyVcardText();
        });
      return;
    }

    fallbackCopyVcardText();
  }

  function fallbackCopyVcardText() {
    vcardText.focus();
    vcardText.select();
    document.execCommand("copy");
    addLog("Copied vCard text to clipboard.", false);
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function exportCsv() {
    var rows = [["id", "name", "timestamp"]].concat(
      records.map(function (record) {
        return [record.id, record.name, record.timestamp];
      })
    );
    var csv = rows.map(csvRow).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gait_session_export_" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    addLog("Exported " + records.length + " " + pluralize(records.length, "record", "records") + " to CSV.", false);
  }

  function csvRow(row) {
    return row.map(function (value) {
      return '"' + String(value).replace(/"/g, '""') + '"';
    }).join(",");
  }

  function resetSessionData() {
    if (!window.confirm("Reset all locally saved session data? This cannot be undone.")) {
      addLog("Reset cancelled; session data was preserved.", true);
      return;
    }

    records = [];
    latestRegisteredRecord = null;
    saveRecords(records);
    render();
    addLog("Session data reset. Ready for Subject " + getNextId() + ".", false);
  }

  function formatTimestamp(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function pluralize(count, singular, plural) {
    return count === 1 ? singular : plural;
  }
})();
