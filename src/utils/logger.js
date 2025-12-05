// Stores the last 500 log messages
const LOG_LIMIT = 500;
const logs = [];

const init = () => {
    // Save original functions
    const originalLog = console.log;
    const originalError = console.error;

    // Override console.log
    console.log = (...args) => {
        const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        
        logs.push({ time: timestamp, type: 'INFO', message });
        if (logs.length > LOG_LIMIT) logs.shift(); // Keep buffer small
        
        originalLog.apply(console, args); // Print to real terminal too
    };

    // Override console.error
    console.error = (...args) => {
        const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        
        logs.push({ time: timestamp, type: 'ERROR', message });
        if (logs.length > LOG_LIMIT) logs.shift();
        
        originalError.apply(console, args);
    };

    console.log("✅ Logger Module Attached");
};

const getLogs = () => logs;

module.exports = { init, getLogs };
