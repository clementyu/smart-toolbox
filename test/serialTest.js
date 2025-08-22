// This script provides a command-line interface for testing UART communication.
// It uses the 'serialport' library to send and receive data.

// Import necessary modules
const { SerialPort } = require('serialport');
const readline = require('readline');

// --- Configuration ---
// The default serial port and baud rate can be overridden by command-line arguments.
const defaultPort = '/dev/tty.usbserial-A50285BI';
const defaultBaudRate = 115200;

// Parse command-line arguments to get the port and baud rate.
const args = process.argv.slice(2);
const portName = args[0] || defaultPort;
const baudRate = args[1] ? parseInt(args[1], 10) : defaultBaudRate;

// --- Initialize Serial Port ---
// Create a new SerialPort instance with the specified configuration.
const port = new SerialPort({
  path: portName,
  baudRate: baudRate,
});

// --- Handle Serial Port Events ---
// The 'open' event is fired once the port is successfully opened.
port.on('open', () => {
  console.log(`✅ Serial port connected on ${portName} at ${baudRate} baud.`);
  startInputLoop();
});

// The 'data' event is fired whenever data is received from the serial port.
port.on('data', (data) => {
  console.log(`\n⬇️  Received response (hex): ${data.toString('hex')}`);
  console.log(`⬇️  Received response (ASCII): ${data.toString('utf-8')}`);
});

// The 'error' event is fired if a communication error occurs.
port.on('error', (err) => {
  console.error(`❌ Serial port error: ${err.message}`);
  // Exit the process on error to prevent further issues.
  process.exit(1);
});

// The 'close' event is fired when the serial port is disconnected.
port.on('close', () => {
  console.log('🔌 Serial port disconnected.');
  process.exit(0);
});

// --- User Input Interface ---
// Set up a readline interface to handle user input from the console.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * Starts the continuous loop to prompt the user for hexadecimal input.
 */
function startInputLoop() {
  rl.question('➡️  Enter hex bytes to send (e.g., "7e000201017e", "7e 00", or "0x7e, 0x00"): ', (hexString) => {
    // A more robust way to handle multiple input formats.
    // 1. Split the string by spaces or commas.
    const parts = hexString.split(/[,\s]+/);
    
    // 2. Remove empty strings and '0x' prefixes from each part.
    const cleanedParts = parts.filter(Boolean).map(part => {
      return part.startsWith('0x') ? part.substring(2) : part;
    });

    // 3. Join the parts to form a single, clean hex string.
    const finalHexString = cleanedParts.join('');

    // Validate the input to ensure it's a valid hexadecimal string of even length.
    if (!/^[0-9a-fA-F]+$/.test(finalHexString)) {
      console.log('⚠️  Invalid hex input. Please enter a valid hexadecimal string.');
    } else if (finalHexString.length % 2 !== 0) {
      console.log('⚠️  Invalid hex input. The length must be an even number.');
    } else {
      try {
        // Convert the valid hex string into a Buffer of binary bytes.
        const hexBuffer = Buffer.from(finalHexString, 'hex');
        
        // Write the binary data to the serial port.
        port.write(hexBuffer, (err) => {
          if (err) {
            return console.error(`❌ Error writing to port: ${err.message}`);
          }
          console.log(`⬆️  Sent hex bytes: ${finalHexString}`);
        });
      } catch (e) {
        console.error(`❌ Conversion error: ${e.message}`);
      }
    }
    // Continue the input loop by calling the function recursively.
    startInputLoop();
  });
}
