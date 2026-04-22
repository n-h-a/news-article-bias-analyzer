const sendLog = (level, msg, data = {}) => {
    try {
        chrome.runtime.sendMessage({ type: 'LOG', level, msg, data });
    } catch (error) {
        const method = level === 'error' ? 'error' : 'log';
        console[method](`[${level.toUpperCase()}] ${msg}`, data, error);
    }
};

const Logger = {
    info: (msg, data = {}) => sendLog('info', msg, data),
    error: (msg, data = {}) => sendLog('error', msg, data)
};

export default Logger;