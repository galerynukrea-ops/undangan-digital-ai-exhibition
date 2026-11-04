let app;
let initError = null;

try {
    app = require('../server/index');
} catch (err) {
    initError = err;
    console.error('[API Init Error]', err);
}

module.exports = (req, res) => {
    if (initError) {
        return res.status(500).json({
            success: false,
            error: 'Lambda initialization error',
            message: initError.message,
            stack: initError.stack
        });
    }
    return app(req, res);
};
