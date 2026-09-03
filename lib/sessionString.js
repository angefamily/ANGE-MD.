const fs = require('fs');
const path = require('path');

// Encode tout le contenu du dossier de session (creds.json + clés) en une
// seule chaîne, pour pouvoir la coller dans la variable d'environnement
// SESSION_ID et éviter de rescanner à chaque redémarrage (utile sur un plan
// gratuit sans disque persistant).
function encodeSession(sessionPath) {
    const files = fs.readdirSync(sessionPath).filter((f) => f.endsWith('.json'));
    const bundle = {};
    for (const file of files) {
        bundle[file] = fs.readFileSync(path.join(sessionPath, file)).toString('base64');
    }
    return Buffer.from(JSON.stringify(bundle)).toString('base64');
}

function restoreSession(sessionPath, sessionId) {
    try {
        const bundle = JSON.parse(Buffer.from(sessionId, 'base64').toString('utf-8'));
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
        for (const [file, base64Content] of Object.entries(bundle)) {
            fs.writeFileSync(path.join(sessionPath, file), Buffer.from(base64Content, 'base64'));
        }
        return true;
    } catch (e) {
        console.error('❌ SESSION_ID invalide, impossible de restaurer la session:', e.message);
        return false;
    }
}

module.exports = { encodeSession, restoreSession };
