const Logger = {
    info: (msg, data = {}) => {
        chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg, data });
    },
    error: (msg, data = {}) => {
        chrome.runtime.sendMessage({ type: 'LOG', level: 'error', msg, data });
    }
};

export default Logger;