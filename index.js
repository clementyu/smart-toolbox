// index.js - Combined Server and RFID Logic with yargs
// This script uses the 'yargs' library for robust command-line argument parsing.

const express = require('express');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load environment variables from .env file

// --- Constants ---
const Constants = {
  // Serial port defaults
  DEFAULT_PORT: '/dev/ttyUSB0',
  DEFAULT_BAUDRATE: 115200,

  // Modes
  MODE_AUTO: 'auto',
  MODE_INVENTORY: 'inventory',
  MODE_INTERACTIVE: 'interactive',
  MODE_READ_TAG: 'read-tag',

  // Protocol bytes
  HEADER_BYTE: 0xFF,

  // Command Codes
  CMD_START_APP: 0x04,
  CMD_GET_RUNNING_STAGE: 0x0C,
  CMD_RFID_INVENTORY: 0x21,
  CMD_MULTI_TAG_INVENTORY: 0xAA,

  // Firmware running stages
  STAGE_BOOTLOADER: 0x11,
  STAGE_APP: 0x12,

  // Status Codes
  STATUS_SUCCESS: 0x0000,

  // Hex commands (without CRC)
  HEX_START_APP: 'ff00041d0b',
  HEX_GET_RUNNING_STAGE: 'ff000c1d03',
  HEX_SCAN_START: 'ff13aa4d6f64756c6574656368aa480000000000f2bbe1cb',
  HEX_SCAN_STOP: 'ff0eaa4d6f64756c6574656368aa49f3bb',

  // File and output strings
  TSV_FILE_NAME: 'epc_scan_data.tsv',
  TSV_HEADER: ['id', 'timestamp', 'EPC', 'item', 'scanned times'].join('\t'),
  TSV_ITEM_ID_PLACEHOLDER: 'N/A'
};

// --- CRC-16-CCITT Implementation ---
const MSG_CRC_INIT = 0xFFFF;
const MSG_CCITT_CRC_POLY = 0x1021;

class CRC {
  constructor(poly_value = MSG_CCITT_CRC_POLY, init_value = MSG_CRC_INIT) {
    this.init_value = init_value;
    this.poly_value = poly_value;
    this.value = 0;
    this.reset();
  }

  reset() { this.value = this.init_value; }

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

  calculate(data) {
    this.reset();
    for (const b of data) { this.crc8(b); }
    return this.value;
  }
}

// --- Configuration and Argument Parsing using yargs ---
// Main application logic is now wrapped in an async function to support dynamic imports
async function main() {
  const yargs = (await import('yargs')).default;
  const { hideBin } = await import('yargs/helpers');

  const argv = yargs(hideBin(process.argv))
    .option('port', {
        alias: 'p',
        type: 'string',
        describe: 'The serial port to connect to.',
        default: Constants.DEFAULT_PORT
    })
    .option('baudrate', {
        alias: 'b',
        type: 'number',
        describe: 'The baud rate for the serial connection.',
        default: Constants.DEFAULT_BAUDRATE
    })
    .option('mode', {
      alias: 'm',
      type: 'string',
      default: Constants.MODE_AUTO,
      describe: 'Operational mode: auto, inventory, interactive, or read-tag.'
    })
    .option('inventory', {
      alias: 'i',
      type: 'string',
      describe: 'Path to the inventory CSV file. Required for inventory mode.'
    })
    .option('refresh-period', {
      alias: 'r',
      type: 'number',
      default: 5,
      describe: 'Time interval in seconds for updating the log on the web page.'
    })
    .option('dbg', {
      alias: 'd',
      type: 'boolean',
      default: true,
      describe: 'Enable or disable debug logs (0 for off, 1 for on).'
    })
    .argv;

  let { port: portName, baudrate: baudRate, mode, inventory, refreshPeriod, dbg } = argv;
  let inventoryFilePath = inventory;
  let inventoryMode = mode === Constants.MODE_INVENTORY;
  let isDbgLogEnabled = dbg;

  if (mode === Constants.MODE_INVENTORY && !inventoryFilePath) {
      console.error(`❌ Inventory mode requires an inventory file. Please specify one using --inventory=<path>.`);
      process.exit(1);
  }

  // --- Global State ---
  let packetBuffer = Buffer.alloc(0);
  let autoModeState = 0;
  let isScanning = false;
  let refreshIntervalId = null;
  const scannedTagsCumulative = new Map();
  const scannedTagsRefresh = new Map();
  const inventoryData = new Map();
  let wsClients = [];
  let readTagScans = new Map(); // New map to track scans in read-tag mode

  // --- Inventory Loading Function ---
  function loadInventory(filePath) {
      if (isDbgLogEnabled) console.log('[DEBUG] Entering function loadInventory');
      try {
          const data = fs.readFileSync(filePath, 'utf8');
          parseInventoryData(data);
      } catch (err) {
          if (isDbgLogEnabled) console.error('❌ Failed to read or parse the inventory CSV file:', err);
      }
  }

  function parseInventoryData(csvData) {
      inventoryData.clear();
      const lines = csvData.split('\n').filter(line => line.trim() !== '');
      if (lines.length === 0) return;
      const headers = lines[0].split(',').map(header => header.trim());
      const idIndex = headers.indexOf('id');
      const epcIndex = headers.indexOf('EPC');
      const itemIndex = headers.indexOf('item');
      if (epcIndex === -1) {
          if (isDbgLogEnabled) console.error('❌ Error: The inventory CSV file must have an "EPC" column.');
          return;
      }

      for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',');
          const id = idIndex !== -1 ? parseInt(values[idIndex], 10) : i;
          const epc = values[epcIndex].trim();
          const item = itemIndex !== -1 ? values[itemIndex].trim() : 'N/A';
          if (epc) { inventoryData.set(epc, { id, epc, item }); }
      }
  }

  // --- Initialize Serial Port ---
  const port = new SerialPort({ path: portName, baudRate: baudRate });

  function sendWithCrc(data, logMessage = 'Sending command') {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function sendWithCrc');
    const crcCalculator = new CRC();
    const calculatedCrc = crcCalculator.calculate(data.slice(1));
    const crcBuffer = Buffer.alloc(2);
    crcBuffer.writeUInt16BE(calculatedCrc);
    const packetToSend = Buffer.concat([data, crcBuffer]);
    port.write(packetToSend, (err) => {
      if (err) { console.error(`❌ Error writing to port: ${err.message}`); }
    });
    const hexString = data.toString('hex');
    if (hexString.startsWith(Constants.HEX_SCAN_START)) {
      isScanning = true;
      scannedTagsCumulative.clear();
      scannedTagsRefresh.clear();
      if (refreshIntervalId) clearInterval(refreshIntervalId);
      refreshIntervalId = setInterval(logScannedTags, refreshPeriod * 1000);
      if (mode === Constants.MODE_INVENTORY) {
        console.log('✅ Scanning session started in inventory mode. Output will be sent via WebSocket every ' + refreshPeriod + ' seconds.');
      } else if (mode === Constants.MODE_READ_TAG) {
        console.log('✅ Scanning session started in read-tag mode.  Output will be sent via WebSocket.');
      }
      else {
        console.log('✅ Scanning session started in auto mode. Output will be sent via WebSocket every ' + refreshPeriod + ' seconds.');
      }
    } else if (hexString.startsWith(Constants.HEX_SCAN_STOP)) {
      if (isScanning) {
        isScanning = false;
        if (refreshIntervalId) clearInterval(refreshIntervalId);
        logScannedTags();
        console.log('🛑 Scanning stopped. Data saved.');
      }
    }
  }

  function parseResponse(buffer) {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function parseResponse');

    if (isDbgLogEnabled) {
      console.log(`[DEBUG] Received Raw Packet: ${buffer.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')}`);
    }

    if (buffer[0] !== Constants.HEADER_BYTE) {
      if (isDbgLogEnabled) {
        console.log('[DEBUG] Header check failed. Dropping packet.');
      }
      return;
    }

    const dataLength = buffer[1];
    const commandCode = buffer[2];
    const statusCode = buffer.readUInt16BE(3);
    const payloadStartIndex = 5;
    const payloadEndIndex = payloadStartIndex + dataLength;
    const payload = buffer.slice(payloadStartIndex, payloadEndIndex);

    if (isDbgLogEnabled) {
      console.log(`[DEBUG] Command: 0x${commandCode.toString(16).toUpperCase()}, Status: 0x${statusCode.toString(16).toUpperCase()}`);
    }

    if (commandCode === Constants.CMD_START_APP && buffer.toString('hex') === 'ff1404000000000000a4000300202205232205230000000010377c') {
      if (mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY || mode === Constants.MODE_READ_TAG) {
        autoModeState = 2;
        sendWithCrc(Buffer.from(Constants.HEX_SCAN_START, 'hex'));
      }
    } else if (commandCode === Constants.CMD_GET_RUNNING_STAGE) {
      const runningStage = payload[0];
      if (runningStage === Constants.STAGE_APP) {
        if ((mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY || mode === Constants.MODE_READ_TAG) && autoModeState === 1) {
          autoModeState = 2;
          sendWithCrc(Buffer.from(Constants.HEX_SCAN_START, 'hex'));
        }
      } else if (runningStage === Constants.STAGE_BOOTLOADER) {
        if ((mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY || mode === Constants.MODE_READ_TAG) && autoModeState === 1) {
          autoModeState = 0;
          sendWithCrc(Buffer.from(Constants.HEX_START_APP, 'hex'));
        }
      }
    } else if (isScanning && (commandCode === Constants.CMD_RFID_INVENTORY || commandCode === Constants.CMD_MULTI_TAG_INVENTORY) && statusCode === Constants.STATUS_SUCCESS) {
      const epcData = payload.slice(5, payload.length - 2);
      const epcHex = epcData.toString('hex').toUpperCase();

      if (mode === Constants.MODE_READ_TAG) {
        // Increment count for the scanned tag in the current session
        const currentCount = (readTagScans.get(epcHex) || 0) + 1;
        readTagScans.set(epcHex, currentCount);

        // Find the EPC with the highest count in the current session
        let mostFrequentEpc = '';
        let maxCount = 0;
        for (const [epc, count] of readTagScans.entries()) {
            if (count > maxCount) {
                maxCount = count;
                mostFrequentEpc = epc;
            }
        }
        
        // Send only the most frequent EPC to the clients
        wsClients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ epc: mostFrequentEpc }));
            }
        });
        return; // Exit after handling read-tag mode
      }

      if (inventoryMode && !inventoryData.has(epcHex)) {
        if (isDbgLogEnabled) {
          console.log(`[DEBUG] EPC ${epcHex} not in inventory. Skipping.`);
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

      if (isDbgLogEnabled) {
        console.log(`[DEBUG] EPC ${epcHex} scanned. Count in this period: ${refreshEntry.count}`);
      }
    }
  }

  // --- Handle Serial Port Events ---
  port.on('open', () => {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function port.on(\'open\')');
    if (inventoryMode && !inventoryFilePath) {
      console.error(`❌ Inventory mode requires an inventory file.`);
      process.exit(1);
    }
    if (inventoryFilePath) { loadInventory(inventoryFilePath); }
    if (mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY || mode === Constants.MODE_READ_TAG) { startAutoMode(); }
  });

  port.on('data', (data) => {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function port.on(\'data\')');
    packetBuffer = Buffer.concat([packetBuffer, data]);
    while (packetBuffer.length >= 5) {
      if (packetBuffer[0] !== Constants.HEADER_BYTE) {
        packetBuffer = packetBuffer.slice(1);
        continue;
      }
      try {
        const dataLengthFromField = packetBuffer.readUInt8(1);
        const totalPacketLength = 1 + 1 + 1 + 2 + dataLengthFromField + 2;
        if (packetBuffer.length < totalPacketLength) { break; }
        const packet = packetBuffer.slice(0, totalPacketLength);
        parseResponse(packet);
        packetBuffer = packetBuffer.slice(totalPacketLength);
      } catch (e) {
        if (isDbgLogEnabled) {
          console.log(`[DEBUG] Dropping malformed packet: ${packet.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')}`);
        }
        packetBuffer = Buffer.alloc(0);
        break;
      }
    }
  });

  port.on('error', (err) => {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function port.on(\'error\')');
    console.error(`❌ Serial port error: ${err.message}`);
    process.exit(1);
  });

  port.on('close', () => {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function port.on(\'close\')');
    process.exit(0);
  });

  // --- Server and WebSocket Setup ---
  const app = express();
  const webServerPort = process.env.PORT || 8080;
  const webServerHost = process.env.HOST || 'smart-toolbox.local';

  app.use(express.static(path.join(__dirname, 'web-app')));

  app.get('/download-inventory', (req, res) => {
    const filePath = path.join(__dirname, 'work', 'inventory.csv');
    res.download(filePath);
  });

  const server = app.listen(webServerPort, webServerHost, () => {
      console.log(`Web server listening at http://${webServerHost}:${webServerPort}`);
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', ws => {
      if (isDbgLogEnabled) console.log('[DEBUG] Entering function wss.on(\'connection\')');
      console.log('Client connected via WebSocket.');
      wsClients.push(ws);

      const initialInventory = Array.from(inventoryData.values()).map(item => ({...item, count: 0, timestamp: null}));
      ws.send(JSON.stringify({ initialInventory }));

      ws.on('message', message => {
          const command = message.toString();
          if (isDbgLogEnabled) console.log(`[DEBUG] Received command from client: ${command}`);

          if (command === 'start') {
              mode = inventoryFilePath ? Constants.MODE_INVENTORY : Constants.MODE_AUTO;
              readTagScans.clear();
              sendWithCrc(Buffer.from(Constants.HEX_SCAN_START, 'hex'), 'Received "start" from web client, starting scan');
          } else if (command === 'stop') {
              readTagScans.clear();
              sendWithCrc(Buffer.from(Constants.HEX_SCAN_STOP, 'hex'), 'Received "stop" from web client, stopping scan');
          } else if (command === 'read-tag') {
              mode = Constants.MODE_READ_TAG;
              readTagScans.clear(); // Reset for the new session
              sendWithCrc(Buffer.from(Constants.HEX_SCAN_START, 'hex'), 'Received "read-tag" from web client, starting scan');
          } else if (command.startsWith('upload_inventory:')) {
              const csvData = command.substring('upload_inventory:'.length);
              parseInventoryData(csvData);
              const newInitialInventory = Array.from(inventoryData.values()).map(item => ({...item, count: 0, timestamp: null}));
              wss.clients.forEach(client => {
                  if (client.readyState === 1) { // Check if the client is open
                      client.send(JSON.stringify({ initialInventory: newInitialInventory }));
                  }
              });
              console.log('✅ Inventory updated from client upload.');
          }
      });

      ws.on('close', () => {
          if (isDbgLogEnabled) console.log('[DEBUG] Entering function ws.on(\'close\')');
          console.log('Client disconnected.');
          wsClients = wsClients.filter(client => client !== ws);
      });
  });

  // --- Start-up Logic ---
  if (inventoryMode && !inventoryFilePath) {
      console.error(`❌ Inventory mode requires an inventory file.`);
      process.exit(1);
  }
  if (inventoryFilePath) {
      loadInventory(inventoryFilePath);
  }
  if (mode === Constants.MODE_AUTO || mode === Constants.MODE_INVENTORY || mode === Constants.MODE_READ_TAG) {
      startAutoMode();
  } else {
      console.log('Interactive mode is not supported in this combined version. Running in auto-inventory mode.');
      startAutoMode();
  }


  function startAutoMode() {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function startAutoMode');
    if (isDbgLogEnabled) {
      console.log('[DEBUG] Starting auto mode sequence.');
    }
    sendWithCrc(Buffer.from(Constants.HEX_START_APP, 'hex'));
    autoModeState = 1;
    setTimeout(() => {
      if (autoModeState === 1) {
        if (isDbgLogEnabled) {
          console.log('[DEBUG] App-start command timed out, checking running stage.');
        }
        sendWithCrc(Buffer.from(Constants.HEX_GET_RUNNING_STAGE, 'hex'));
      }
    }, 2000);
  }

  // --- Data Logging and Export Functions ---
  function logScannedTags() {
    if (isDbgLogEnabled) console.log('[DEBUG] Entering function logScannedTags');
    const inventoryUpdates = [];
    scannedTagsRefresh.forEach((data, epc) => {
        const item = inventoryData.get(epc);
        if (item) {
            inventoryUpdates.push({ id: item.id, timestamp: data.timestamp, epc, item: item.item, count: data.count });
        }
    });
    scannedTagsRefresh.clear();
    
    if (inventoryUpdates.length > 0) {
        wsClients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ updates: inventoryUpdates }));
            }
        });
    }
  }

  function generateTsv() {
    const tsvRows = [];

    let id = 1;
    scannedTagsCumulative.forEach((data, epc) => {
      const item = inventoryData.get(epc);
      const item_name = item ? item.item : 'N/A';
      const row = [id++, data.timestamp, epc, item_name, data.count].join('\t');
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
}

// Call the async main function
main();
