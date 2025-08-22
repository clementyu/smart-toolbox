// This script provides a command-line interface for testing UART communication.
// It is enhanced to support an interactive mode, an auto-start mode, and a
// new inventory mode with filtered and periodic log updates.

// Import necessary modules
const { SerialPort } = require('serialport');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// --- Constants ---
const Constants = {
  // Serial port defaults
  DEFAULT_PORT: '/dev/tty.usbserial-A50285BI',
  DEFAULT_BAUDRATE: 115200,

  // Command-line arguments
  MODE_ARG: '--mode=',
  INVENTORY_ARG: '--inventory',
  REFRESH_PERIOD_ARG: '--refresh-period=',
  MODE_AUTO: 'auto',
  MODE_INTERACTIVE: 'interactive',
  MODE_INVENTORY: 'inventory',

  // Protocol bytes
  HEADER_BYTE: 0xFF,
  
  // Command Codes
  CMD_START_APP: 0x04,
  CMD_GET_RUNNING_STAGE: 0x0C,
  CMD_RFID_INVENTORY: 0x21,
  CMD_READ_DATA_AREA: 0x28,
  CMD_MULTI_TAG_INVENTORY: 0xAA,

  // Firmware running stages
  STAGE_BOOTLOADER: 0x11,
  STAGE_APP: 0x12,
  STAGE_UNKNOWN: 0x13,

  // Status Codes
  STATUS_SUCCESS: 0x0000,
  STATUS_NO_TAG: 0x0400,

  // Hex commands
  HEX_START_APP: 'ff00041d0b',
  HEX_GET_RUNNING_STAGE: 'ff000c1d03',
  HEX_SCAN_START: 'ff13aa4d6f64756c6574656368aa480000000000f2bbe1cb',
  HEX_SCAN_STOP: 'ff0eaa4d6f64756c6574656368aa49f3bb',
  
  // File and output strings
  TSV_FILE_NAME: 'epc_scan_data.tsv',
  TSV_HEADER: ['id', 'timestamp', 'EPC', 'tag', 'scanned times'].join('\t'),
  TSV_ITEM_ID_PLACEHOLDER: 'N/A'
};

// --- CRC-16-CCITT Implementation ---
const MSG_CRC_INIT = 0xFFFF;
const MSG_CCITT_CRC_POLY = 0x1021;

function to_hex(v) {
  return `0x${v.toString(16).toUpperCase()}`;
}

class CRC {
  constructor(poly_value = MSG_CCITT_CRC_POLY, init_value = MSG_CRC_INIT) {
    this.init_value = init_value;
    this.poly_value = poly_value;
    this.value = 0;
    this.reset();
  }

  reset() {
    this.value = this.init_value;
  }

  push(b) {
    this.crc8(b);
    return this.value;
  }

  crc8(v) {
    var xorFlag = 0;
    var bit = 0;
    var dcdBitMask = 0x80;

    for (let i = 0; i < 8; i++) {
      xorFlag = this.value & 0x8000;
      this.value = (this.value << 1) & 0xFFFF;
      bit = ((v & dcdBitMask) === dcdBitMask);
      this.value = this.value | bit;
      if (xorFlag > 0) {
        this.value = this.value ^ this.poly_value;
      }
      dcdBitMask = dcdBitMask >> 1;
    }
  }

  calculate(data, verbose = false) {
    this.reset();
    for (let index = 0; index < data.length; index++) {
      const b = data[index];
      this.crc8(b);
      if (verbose) {
        console.log(`buffer[${index}] = ${to_hex(b)}, crc = ${to_hex(this.value)}`);
      }
    }
    return this.value;
  }
}

// --- Configuration and Argument Parsing ---
const args = process.argv.slice(2);
let portName = Constants.DEFAULT_PORT;
let baudRate = Constants.DEFAULT_BAUDRATE;
let mode = Constants.MODE_AUTO;
let inventoryFilePath = null;
let inventoryMode = false;
let refreshPeriod = 5; // Default refresh period is 5 seconds
let isVerboseLogEnabled = true;

const modeArg = args.find(arg => arg.startsWith(Constants.MODE_ARG));
if (modeArg) {
  mode = modeArg.split('=')[1];
  if (mode === Constants.MODE_INVENTORY) {
      inventoryMode = true;
      isVerboseLogEnabled = false; // Disable verbose logs in inventory mode
  }
}

const inventoryArg = args.find(arg => arg.startsWith(Constants.INVENTORY_ARG));
if (inventoryArg) {
    const parts = inventoryArg.split('=');
    inventoryMode = true;
    if (parts.length > 1) {
        inventoryFilePath = parts[1];
    }
}

const refreshPeriodArg = args.find(arg => arg.startsWith(Constants.REFRESH_PERIOD_ARG));
if (refreshPeriodArg) {
  refreshPeriod = parseInt(refreshPeriodArg.split('=')[1], 10);
  if (isNaN(refreshPeriod) || refreshPeriod <= 0) {
    console.warn(`⚠️ Invalid refresh period, defaulting to 5 seconds.`);
    refreshPeriod = 5;
  }
}

const positionalArgs = args.filter(arg => !arg.startsWith(Constants.MODE_ARG) && !arg.startsWith(Constants.INVENTORY_ARG) && !arg.startsWith(Constants.REFRESH_PERIOD_ARG));
if (positionalArgs[0]) {
  portName = positionalArgs[0];
}
if (positionalArgs[1]) {
  baudRate = parseInt(positionalArgs[1], 10);
}

// --- Global State ---
let packetBuffer = Buffer.alloc(0);
let autoModeState = 0;
let isScanning = false;
let refreshIntervalId = null;
const scannedTagsCumulative = new Map(); // Tracks total scans for TSV export
const scannedTagsRefresh = new Map(); // Tracks scans for the current refresh period
const inventory = new Map();

// --- Inventory Loading Function ---
function loadInventory(filePath) {
    console.log(`\n⏳ Loading inventory from ${filePath}...`);
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim() !== '');
        const headers = lines[0].split(',').map(header => header.trim());
        
        const epcIndex = headers.indexOf('EPC');
        const tagIndex = headers.indexOf('tag');

        if (epcIndex === -1) {
            console.error('❌ Error: The inventory CSV file must have an "EPC" column.');
            return;
        }

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',');
            const epc = values[epcIndex].trim();
            const tag = tagIndex !== -1 ? values[tagIndex].trim() : Constants.TSV_ITEM_ID_PLACEHOLDER;
            if (epc) {
                inventory.set(epc, tag);
            }
        }
        console.log(`✅ Successfully loaded ${inventory.size} items into inventory.`);
    } catch (err) {
        console.error('❌ Failed to read or parse the inventory CSV file:', err);
    }
}

// --- Initialize Serial Port ---
const port = new SerialPort({
  path: portName,
  baudRate: baudRate,
});

// Helper function to send data with CRC
function sendWithCrc(data, logMessage = 'Sending command') {
  const crcCalculator = new CRC();
  const calculatedCrc = crcCalculator.calculate(data.slice(1));
  const crcBuffer = Buffer.alloc(2);
  crcBuffer.writeUInt16BE(calculatedCrc);
  const packetToSend = Buffer.concat([data, crcBuffer]);

  port.write(packetToSend, (err) => {
    if (err) {
      return console.error(`❌ Error writing to port: ${err.message}`);
    }
    if (isVerboseLogEnabled) {
      console.log(`\n⬆️  ${logMessage}: ${packetToSend.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')}`);
    } else {
      console.log(`\n⬆️  ${logMessage}: ${packetToSend.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')}`);
    }
  });

  const hexString = data.toString('hex');
  if (hexString.startsWith(Constants.HEX_SCAN_START)) {
    isScanning = true;
    scannedTagsCumulative.clear();
    scannedTagsRefresh.clear();
    console.log(`\n✅ Scanning session started. Ready to receive EPC tags. Output will refresh every ${refreshPeriod} seconds.`);
    refreshIntervalId = setInterval(logScannedTags, refreshPeriod * 1000);
  } else if (hexString.startsWith(Constants.HEX_SCAN_STOP)) {
    if (isScanning) {
      isScanning = false;
      clearInterval(refreshIntervalId);
      logScannedTags(); // Log one last time before saving
      console.log(`\n🛑 Scanning stopped. Saving data...`);
      saveTsvFile();
    }
  }
}

// --- Protocol Parser ---
function parseResponse(buffer) {
  if (isVerboseLogEnabled) {
    console.log('\n--- Parsing Response ---');
    console.log(`Raw Hex: ${buffer.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')}`);
  }

  if (buffer[0] !== Constants.HEADER_BYTE) {
    if (isVerboseLogEnabled) {
      console.log('❌ Header check failed: First byte is not FF.');
    }
    return;
  }
  if (isVerboseLogEnabled) {
    console.log('✅ Header: FF');
  }

  const receivedCrc = buffer.readUInt16BE(buffer.length - 2);
  const dataForCrc = buffer.slice(1, buffer.length - 2);
  const crcCalculator = new CRC();
  const calculatedCrc = crcCalculator.calculate(dataForCrc);
  
  if (isVerboseLogEnabled) {
    if (receivedCrc === calculatedCrc) {
      console.log(`✅ CRC check passed! Received CRC: 0x${receivedCrc.toString(16).toUpperCase()}, Calculated CRC: 0x${calculatedCrc.toString(16).toUpperCase()}`);
    } else {
      console.log(`❌ CRC check failed! Received CRC: 0x${receivedCrc.toString(16).toUpperCase()}, Calculated CRC: 0x${calculatedCrc.toString(16).toUpperCase()}`);
    }
  }

  const dataLength = buffer[1];
  if (isVerboseLogEnabled) {
    console.log(`✅ Declared Data Length: ${dataLength} bytes`);
  }

  const commandCode = buffer[2];
  const commandCodeHex = commandCode.toString(16).toUpperCase().padStart(2, '0');
  if (isVerboseLogEnabled) {
    console.log(`✅ Command Code: 0x${commandCodeHex}`);
  }

  const statusCode = buffer.readUInt16BE(3);
  const statusCodeHex = statusCode.toString(16).toUpperCase().padStart(4, '0');
  let statusMessage = `0x${statusCodeHex}`;
  
  if (statusCode === Constants.STATUS_SUCCESS) {
    statusMessage = `0x${statusCodeHex} (Success)`;
  } else if (statusCode === Constants.STATUS_NO_TAG) {
    statusMessage = `0x${statusCodeHex} (No tag read)`;
  }
  if (isVerboseLogEnabled) {
    console.log(`✅ Status Code: ${statusMessage}`);
  }

  const payloadStartIndex = 5;
  const payloadEndIndex = payloadStartIndex + dataLength;
  const payload = buffer.slice(payloadStartIndex, payloadEndIndex);
  if (isVerboseLogEnabled) {
    console.log(`✅ Payload (Full): ${payload.toString('hex').toUpperCase()}`);
  }
  
  if (commandCode === Constants.CMD_START_APP) {
    if (buffer.toString('hex') === 'ff1404000000000000a4000300202205232205230000000010377c') {
      if (isVerboseLogEnabled) {
        console.log('✅ The device has responded correctly to the app-start command. App firmware is running.');
      }
      if (mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY && autoModeState === 0) {
        autoModeState = 2;
        console.log('✅ Auto-start mode sequence complete. Starting continuous scanning...');
        sendWithCrc(Buffer.from(Constants.HEX_SCAN_START, 'hex'));
      }
    }
  } else if (commandCode === Constants.CMD_GET_RUNNING_STAGE) {
      const runningStage = payload[0];
      let runningStageMessage = `0x${runningStage.toString(16).toUpperCase().padStart(2, '0')}`;
      if (runningStage === Constants.STAGE_APP) {
        runningStageMessage += " (App Mode)";
        if (isVerboseLogEnabled) {
          console.log(`✅ Device is running App firmware.`);
        }
        if (mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY && autoModeState === 1) {
          autoModeState = 2;
          console.log('✅ Auto-start mode sequence complete. Starting continuous scanning...');
          sendWithCrc(Buffer.from(Constants.HEX_SCAN_START, 'hex'));
        }
      } else if (runningStage === Constants.STAGE_BOOTLOADER) {
        runningStageMessage += " (Bootloader Mode)";
        if (isVerboseLogEnabled) {
          console.log(`❌ Device is running Bootloader firmware. Attempting to switch to App mode...`);
        }
        if (mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY && autoModeState === 1) {
          autoModeState = 0;
          sendWithCrc(Buffer.from(Constants.HEX_START_APP, 'hex'), 'Switching to App Mode');
        }
      } else {
         runningStageMessage += " (Unknown Mode)";
      }
      if (isVerboseLogEnabled) {
        console.log(`  > Running Stage: ${runningStageMessage}`);
      }
  } else if (commandCode === Constants.CMD_RFID_INVENTORY || commandCode === Constants.CMD_MULTI_TAG_INVENTORY) {
      if (isScanning && statusCode === Constants.STATUS_SUCCESS) {
          // The protocol seems to be inconsistent, so we need to be smart about extracting EPC data.
          // Based on the provided log for 0x21, the EPC data starts 8 bytes into the payload.
          // Let's assume the EPC data for both 0x21 and 0xAA starts at a consistent offset from the command code.
          const epcData = payload.slice(5, payload.length - 2);
          const epcHex = epcData.toString('hex').toUpperCase();

          if (inventoryMode && !inventory.has(epcHex)) {
            if (isVerboseLogEnabled) {
              console.log(`➡️  EPC: ${epcHex} (not in inventory), skipping.`);
            }
            return;
          }

          const cumulativeEntry = scannedTagsCumulative.get(epcHex) || { count: 0, timestamp: '' };
          cumulativeEntry.count++;
          cumulativeEntry.timestamp = new Date().toISOString();
          scannedTagsCumulative.set(epcHex, cumulativeEntry);
          
          const refreshEntry = scannedTagsRefresh.get(epcHex) || { count: 0, timestamp: '' };
          refreshEntry.count++;
          refreshEntry.timestamp = new Date().toISOString();
          scannedTagsRefresh.set(epcHex, refreshEntry);
      }
      if (isVerboseLogEnabled) {
        const option = payload[0];
        const metadataFlags = payload.readUInt16BE(1);
        // Correctly extracting EPC data
        const epcData = payload.slice(3, payload.length - 2);
        const tagCrc = payload.slice(payload.length - 2);
        console.log(`  > Option: 0x${option.toString(16).toUpperCase().padStart(2, '0')}`);
        console.log(`  > Metadata Flags: 0x${metadataFlags.toString(16).toUpperCase().padStart(4, '0')}`);
        console.log(`  > EPC Data: ${epcData.toString('hex').toUpperCase()}`);
        console.log(`  > Tag CRC: ${tagCrc.toString('hex').toUpperCase()}`);
      }
  } else if (commandCode === Constants.CMD_READ_DATA_AREA) {
      if (isVerboseLogEnabled) {
        const option = payload[0];
        const tidData = payload.slice(1);
        console.log(`  > Option: 0x${option.toString(16).toUpperCase().padStart(2, '0')}`);
        console.log(`  > TID Data: ${tidData.toString('hex').toUpperCase()}`);
      }
  }
  if (isVerboseLogEnabled) {
    const crc = buffer.slice(payloadEndIndex);
    console.log(`✅ Final CRC: ${crc.toString('hex').toUpperCase()}`);
    console.log('--- End of Parsing ---');
  }
}

// --- Handle Serial Port Events ---
port.on('open', () => {
  console.log(`✅ Serial port connected on ${portName} at ${baudRate} baud.`);
  if (inventoryMode && !inventoryFilePath) {
      console.error(`❌ Inventory mode requires an inventory file. Please specify one using ${Constants.INVENTORY_ARG}=<path> or --inventory <path>.`);
      process.exit(1);
  }
  if (inventoryFilePath) {
      loadInventory(inventoryFilePath);
  }

  if (mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY) {
    startAutoMode();
  } else {
    startInteractiveMode();
  }
});

port.on('data', (data) => {
  packetBuffer = Buffer.concat([packetBuffer, data]);
  
  while (packetBuffer.length >= 5) {
    if (packetBuffer[0] !== Constants.HEADER_BYTE) {
      if (isVerboseLogEnabled) {
        console.log(`❌ Invalid packet header. Discarding byte: ${packetBuffer[0].toString(16).toUpperCase()}`);
      }
      packetBuffer = packetBuffer.slice(1);
      continue;
    }
    
    try {
      const dataLengthFromField = packetBuffer.readUInt8(1);
      const totalPacketLength = 1 + 1 + 1 + 2 + dataLengthFromField + 2;

      if (packetBuffer.length < totalPacketLength) {
        break;
      }
      
      const packet = packetBuffer.slice(0, totalPacketLength);
      parseResponse(packet);
      packetBuffer = packetBuffer.slice(totalPacketLength);
    } catch (e) {
      console.log(`\n❌ Error parsing packet: ${e.message}`);
      console.log(`❌ Dropping malformed packet: ${packetBuffer.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')}`);
      packetBuffer = Buffer.alloc(0);
      break;
    }
  }
});

port.on('error', (err) => {
  console.error(`❌ Serial port error: ${err.message}`);
  process.exit(1);
});

port.on('close', () => {
  console.log('🔌 Serial port disconnected.');
  process.exit(0);
});

// Graceful shutdown on Ctrl+C to save the file
process.on('SIGINT', () => {
  console.log('\n\n🚨 Caught interrupt signal. Attempting to stop scanning...');
  const stopCommand = Buffer.from(Constants.HEX_SCAN_STOP, 'hex');
  sendWithCrc(stopCommand, 'Sending stop command');

  setTimeout(() => {
    console.log('Exiting program.');
    process.exit();
  }, 1000);
});

// --- User Input Interface ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function startInteractiveMode() {
  rl.question('➡️  Enter hex bytes to send (or type "save" to export, "stop" to stop scanning): ', (input) => {
    const sanitizedInput = input.trim().toLowerCase();
    
    if (sanitizedInput === 'save') {
      saveTsvFile();
    } else if (sanitizedInput === 'stop') {
      const stopCommand = Buffer.from(Constants.HEX_SCAN_STOP, 'hex');
      sendWithCrc(stopCommand, 'Sending stop scanning command');
    } else {
      const parts = sanitizedInput.split(/[,\s]+/);
      const cleanedParts = parts.filter(Boolean).map(part => {
        return part.startsWith('0x') ? part.substring(2) : part;
      });
      const finalHexString = cleanedParts.join('');

      if (!/^[0-9a-fA-F]+$/.test(finalHexString)) {
        console.log('⚠️  Invalid hex input. Please enter a valid hexadecimal string.');
      } else if (finalHexString.length % 2 !== 0) {
        console.log('⚠️  Invalid hex input. The length must be an even number.');
      } else {
        try {
          const hexBuffer = Buffer.from(finalHexString, 'hex');
          sendWithCrc(hexBuffer);
        } catch (e) {
          console.error(`❌ Conversion error: ${e.message}`);
        }
      }
    }
    startInteractiveMode();
  });
}

function startAutoMode() {
  console.log('🚀 Auto-start mode initiated. Checking firmware status...');
  sendWithCrc(Buffer.from(Constants.HEX_START_APP, 'hex'), 'Attempting to start App firmware...');
  autoModeState = 1;

  setTimeout(() => {
    if (autoModeState === 1) {
      console.log('⏳ No response received. Checking current firmware mode...');
      sendWithCrc(Buffer.from(Constants.HEX_GET_RUNNING_STAGE, 'hex'), 'Requesting current running stage');
    }
  }, 2000);
}

// --- Data Logging and Export Functions ---
function logScannedTags() {
    if (scannedTagsRefresh.size > 0) {
        console.log(`\n--- Scanned Tags (Last ${refreshPeriod}s) ---`);
        let id = 1;
        scannedTagsRefresh.forEach((data, epc) => {
            const tag = inventory.get(epc) || Constants.TSV_ITEM_ID_PLACEHOLDER;
            const logLine = `${data.timestamp}, ${id++}, ${epc}, ${tag}, ${data.count} times`;
            console.log(logLine);
        });
        scannedTagsRefresh.clear();
        console.log(`--- End of Refresh ---`);
    } else {
        console.log(`\n--- Scanned Tags (Last ${refreshPeriod}s) ---`);
        console.log('No new EPC tags scanned.');
        console.log('--- End of Refresh ---');
    }
}

function generateTsv() {
  const tsvRows = [];

  let id = 1;
  scannedTagsCumulative.forEach((data, epc) => {
    const tag = inventory.get(epc) || Constants.TSV_ITEM_ID_PLACEHOLDER;
    const row = [id++, data.timestamp, epc, tag, data.count].join('\t');
    tsvRows.push(row);
  });

  return `${Constants.TSV_HEADER}\n${tsvRows.join('\n')}`;
}

function saveTsvFile() {
  if (scannedTagsCumulative.size === 0) {
    console.log('⚠️  No scanned EPC tags to save.');
    return;
  }
  
  const tsvData = generateTsv();
  const filePath = path.join(__dirname, Constants.TSV_FILE_NAME);

  fs.writeFileSync(filePath, tsvData, 'utf8');
  console.log(`\n✅ Successfully saved ${scannedTagsCumulative.size} unique EPC tags to ${filePath}`);
}
