const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const TYPE_MAP = {
    imageMessage: 'image',
    videoMessage: 'video',
    stickerMessage: 'sticker',
    audioMessage: 'audio',
    documentMessage: 'document',
};

// Retourne { message, type } pour le média du message lui-même, ou celui
// qu'il cite en réponse (quoted), sinon null.
async function getMediaMessage(m) {
    const content = m.message;
    if (!content) return null;

    const findMedia = (msg) => {
        if (!msg) return null;
        for (const key of Object.keys(TYPE_MAP)) {
            if (msg[key]) return { message: msg[key], type: TYPE_MAP[key] };
        }
        return null;
    };

    return (
        findMedia(content) ||
        findMedia(content.extendedTextMessage?.contextInfo?.quotedMessage) ||
        null
    );
}

async function bufferFromMessage(mediaMessage, type) {
    const stream = await downloadContentFromMessage(mediaMessage, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

module.exports = { bufferFromMessage, getMediaMessage };
