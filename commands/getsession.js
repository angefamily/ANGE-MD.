const path = require('path');
const { isOwner } = require('../lib/permissions');
const { encodeSession } = require('../lib/sessionString');

module.exports = {
    name: 'getsession',
    description: 'Génère la chaîne SESSION_ID à coller dans les variables Render (owner uniquement)',
    async execute({ sock, m, from }) {
        const senderJid = m.key.participant || from;
        if (!isOwner(senderJid)) {
            return sock.sendMessage(from, { text: '⛔ Owner uniquement.' }, { quoted: m });
        }

        try {
            const sessionPath = path.join(__dirname, '..', 'session', process.env.SESSION_NUMBER || 'default');
            const sessionId = encodeSession(sessionPath);
            await sock.sendMessage(from, {
                text: [
                    '🔑 Voici ton SESSION_ID :',
                    '',
                    sessionId,
                    '',
                    '⚠️ Colle-le dans la variable d\'environnement SESSION_ID sur Render pour éviter de rescanner à chaque redémarrage. Ne le partage jamais, il donne un accès complet à ce compte WhatsApp.',
                ].join('\n'),
            }, { quoted: m });
        } catch (error) {
            await sock.sendMessage(from, { text: `❌ Impossible de générer la session : ${error.message}` }, { quoted: m });
        }
    },
};
