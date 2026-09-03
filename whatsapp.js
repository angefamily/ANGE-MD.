const path = require('path');
const fs = require('fs');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const { sendConnectionConfirmation } = require('./lib/connectionMessage');
const { restoreSession } = require('./lib/sessionString');
const { getSettings } = require('./lib/botSettings');
const { getGroup, isToggled } = require('./lib/groupSettings');
const { getConfig, setConfig } = require('./lib/config');
const { loadCommands, handleMessage } = require('./messageHandler');

const SESSION_NUMBER = process.env.SESSION_NUMBER || 'default';
const SESSION_PATH = path.join(__dirname, 'session', SESSION_NUMBER);

let sock = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | connected
let initInProgress = false;

function setStatus(s) {
    connectionStatus = s;
}

function getStatus() {
    return connectionStatus;
}

async function resetSock() {
    const stale = sock;
    sock = null;
    initInProgress = false;
    setStatus('disconnected');
    if (stale) {
        try {
            stale.end(undefined);
        } catch (_) {}
    }
}

function extractInviteCode(link) {
    const match = /channel\/([A-Za-z0-9]+)/.exec(link || '');
    return match ? match[1] : null;
}

async function followOwnerChannel(sockInstance) {
    const cfg = getConfig();
    try {
        let jid = cfg.newsletterJid;
        const inviteCode = extractInviteCode(cfg.channelLink);

        if (inviteCode) {
            try {
                const meta = await sockInstance.newsletterMetadata('invite', inviteCode);
                if (meta?.id) {
                    jid = meta.id;
                    if (jid !== cfg.newsletterJid) setConfig({ newsletterJid: jid });
                }
            } catch (e) {
                console.error('⚠️ Impossible de résoudre le JID du canal:', e.message);
            }
        }

        if (!jid) return;
        await sockInstance.newsletterFollow(jid);
        console.log(`📢 Abonné automatiquement au canal ${jid}`);
    } catch (e) {
        console.error('Erreur abonnement canal:', e.message);
    }
}

function wireEvents(sockInstance, { onOpen, onClose } = {}) {
    sockInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            setStatus('connected');
            loadCommands();
            if (onOpen) await onOpen();
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('🔌 Connexion fermée.', statusCode, shouldReconnect ? '— reconnexion...' : '— déconnecté définitivement.');

            if (onClose) await onClose(shouldReconnect);

            if (shouldReconnect) {
                setTimeout(() => {
                    startExistingSession().catch((e) => console.error('❌ Erreur de reconnexion:', e.message));
                }, 3000);
            } else {
                await resetSock();
                if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            }
        }
    });

    sockInstance.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
            if (!m.message) continue;
            const isSelfChat = m.key.remoteJid === sockInstance.user?.id?.split(':')[0] + '@s.whatsapp.net';
            if (m.key.fromMe && !isSelfChat) continue;
            try {
                await applyAutoBehaviors(sockInstance, m);
                await handleMessage(sockInstance, m);
            } catch (e) {
                console.error('❌ Erreur messages.upsert:', e.message);
            }
        }
    });

    sockInstance.ev.on('group-participants.update', async (event) => {
        try {
            await handleGroupParticipantsUpdate(sockInstance, event);
        } catch (e) {
            console.error('❌ Erreur group-participants.update:', e.message);
        }
    });

    sockInstance.ev.on('call', async (calls) => {
        const settings = getSettings();
        if (!settings.anticall) return;
        for (const call of calls) {
            try {
                await sockInstance.rejectCall(call.id, call.from);
            } catch (e) {
                console.error('❌ Erreur anticall:', e.message);
            }
        }
    });
}

async function applyAutoBehaviors(sockInstance, m) {
    const from = m.key.remoteJid;
    if (from?.endsWith('@g.us') && isToggled(from, 'autoreact')) {
        try {
            await sockInstance.sendMessage(from, { react: { text: '✨', key: m.key } });
        } catch (_) {}
    }
}

async function handleGroupParticipantsUpdate(sockInstance, event) {
    const { id: groupJid, participants, action } = event;
    const group = getGroup(groupJid);

    if (action === 'add' && group.toggles?.welcome) {
        const template = group.welcomeMessage || '✨ Bienvenue @user dans le royaume céleste ! 👼';
        for (const p of participants) {
            const text = template.replace(/@user/g, `@${p.split('@')[0]}`);
            await sockInstance.sendMessage(groupJid, { text, mentions: [p] });
        }
    }

    if (action === 'remove' && group.toggles?.goodbye) {
        const template = group.goodbyeMessage || '👋 @user a quitté le royaume céleste.';
        for (const p of participants) {
            const text = template.replace(/@user/g, `@${p.split('@')[0]}`);
            await sockInstance.sendMessage(groupJid, { text, mentions: [p] });
        }
    }
}

// Emballe sendMessage pour ajouter un indicateur "en train d'écrire..." +
// un délai réaliste avant les réponses texte (comportement moins robotique).
function wrapSendMessage(sockInstance) {
    const original = sockInstance.sendMessage.bind(sockInstance);
    sockInstance.sendMessage = async (jid, content = {}, options = {}) => {
        if (content.text && !content.react) {
            try {
                await sockInstance.presenceSubscribe(jid);
                await sockInstance.sendPresenceUpdate('composing', jid);
                const length = content.text.length;
                const delay = Math.min(5000, 500 + length * 20 + Math.random() * 700);
                await new Promise((r) => setTimeout(r, delay));
                await sockInstance.sendPresenceUpdate('paused', jid);
            } catch (_) {}
        }
        return original(jid, content, options);
    };
    return sockInstance;
}

// ---------------------------------------------------------------
// Connexion par pairing code (nouvelle demande)
// ---------------------------------------------------------------
async function connectToWhatsApp(number) {
    if (initInProgress) {
        throw new Error('Une connexion est déjà en cours, patiente quelques secondes.');
    }
    const sanitizedNumber = (number || '').replace(/[^0-9]/g, '');
    if (sanitizedNumber.length < 8) {
        throw new Error(`Numéro invalide : "${number}" (n'oublie pas l'indicatif pays, sans le +)`);
    }

    if (sock) {
        await resetSock();
    }
    if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    fs.mkdirSync(SESSION_PATH, { recursive: true });

    initInProgress = true;
    setStatus('connecting');

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['ANGE-MD', 'Chrome', '1.0.0'],
    });
    wrapSendMessage(sock);
    sock.ev.on('creds.update', saveCreds);

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                resetSock().catch(() => {});
                reject(new Error("Délai dépassé pour l'obtention du code, réessaie."));
            }
        }, 60000);

        wireEvents(sock, {
            onOpen: async () => {
                console.log('✅ ANGE-MD connecté à WhatsApp !');
                await followOwnerChannel(sock);
                await new Promise((r) => setTimeout(r, 3000));
                await sendConnectionConfirmation(sock).catch((e) => console.error('❌ Confirmation non envoyée:', e.message));
            },
            onClose: async () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(new Error('Connexion fermée avant la fin du pairing.'));
                }
            },
        });

        setTimeout(async () => {
            if (settled || !sock) return;
            try {
                const code = await sock.requestPairingCode(sanitizedNumber);
                settled = true;
                clearTimeout(timeout);
                initInProgress = false;
                const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                resolve(formatted);
            } catch (e) {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    await resetSock();
                    reject(e);
                }
            }
        }, 1500);
    });
}

// ---------------------------------------------------------------
// Reprise automatique d'une session déjà authentifiée
// ---------------------------------------------------------------
async function startExistingSession() {
    if (sock || !fs.existsSync(path.join(SESSION_PATH, 'creds.json'))) return;

    initInProgress = true;
    setStatus('connecting');

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['ANGE-MD', 'Chrome', '1.0.0'],
    });
    wrapSendMessage(sock);
    sock.ev.on('creds.update', saveCreds);

    wireEvents(sock, {
        onOpen: async () => {
            console.log('✅ ANGE-MD reconnecté automatiquement (session existante) !');
            initInProgress = false;
            await followOwnerChannel(sock);
            await new Promise((r) => setTimeout(r, 3000));
            await sendConnectionConfirmation(sock).catch((e) => console.error('❌ Confirmation non envoyée:', e.message));
        },
        onClose: async () => {
            initInProgress = false;
        },
    });
}

async function resumeIfSessionExists() {
    if (process.env.SESSION_ID && !fs.existsSync(path.join(SESSION_PATH, 'creds.json'))) {
        if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
        restoreSession(SESSION_PATH, process.env.SESSION_ID);
    }
    await startExistingSession();
}

// ---------------------------------------------------------------
// Déconnexion manuelle (pour changer de numéro proprement depuis le site)
// ---------------------------------------------------------------
async function forceDisconnect() {
    if (sock) {
        try {
            await sock.logout();
        } catch (_) {}
    }
    await resetSock();
    if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
}

module.exports = { connectToWhatsApp, getStatus, resumeIfSessionExists, forceDisconnect };
