const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits } = require('discord.js');
const session = require('express-session');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
// -------------------------------------------------------------
// CONFIGURATION DE LA SESSION (CORRIGÉE POUR RENDER & CHROME)
// -------------------------------------------------------------
app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || 'phrase_secrete_par_defaut_123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        maxAge: 1000 * 60 * 60 * 24 // 24h
    }
}));
 
// -------------------------------------------------------------
// VARIABLES D'ENVIRONNEMENT
// -------------------------------------------------------------
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const MODERATOR_ROLE_ID = process.env.MODERATOR_ROLE_ID; 
 
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
 
// -------------------------------------------------------------
// BOT DISCORD
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers
    ]
});
 
client.login(BOT_TOKEN).catch(err => console.error("❌ Erreur de token Bot Discord :", err));
 
client.once('ready', () => {
    console.log(`🤖 Bot Discord en ligne : ${client.user.tag}`);
});
 
// -------------------------------------------------------------
// MIDDLEWARE DE VÉRIFICATION DE RÔLE EN DIRECT (MODIFE 2)
// -------------------------------------------------------------
async function requireAuth(req, res, next) {
    // 1. Est-ce que l'utilisateur s'est déjà connecté avec Discord ?
    if (!req.session || !req.session.user) {
        return res.redirect('/login.html');
    }

    try {
        // 2. On récupère le serveur Discord configuré
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            return res.status(500).send("Erreur de configuration Discord (Serveur introuvable).");
        }

        // 3. On va chercher le membre en direct sur Discord (sans cache)
        const member = await guild.members.fetch({ user: req.session.user.id, force: true });
        
        // 4. On vérifie s'il possède le rôle modérateur
        if (member && member.roles.cache.has(MODERATOR_ROLE_ID)) {
            return next(); // Il a le rôle, tout est bon !
        } else {
            // Il n'a plus le rôle ! On détruit sa session et on affiche la page stylisée
            req.session.destroy();
            return res.status(403).send(`
                <!DOCTYPE html>
                <html lang="fr">
                <head>
                    <meta charset="UTF-8">
                    <title>Accès Refusé</title>
                    <style>
                        body { background: #0d0e14; color: #e8eaf0; font-family: 'Segoe UI', -apple-system, sans-serif; display: flex; height: 100vh; align-items: center; justify-content: center; margin: 0; }
                        .card { background: #13151f; padding: 40px; border-radius: 12px; border: 1px solid #1e2130; text-align: center; max-width: 400px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
                        h1 { color: #ed4245; margin-bottom: 15px; font-size: 1.8rem; font-weight: bold; }
                        p { color: #7a80a0; font-size: 1rem; line-height: 1.6; margin-bottom: 25px; }
                        a { display: inline-block; background: #5865F2; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; transition: 0.2s; }
                        a:hover { background: #4752c4; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>Accès Interdit 🛑</h1>
                        <p>Désolé, ton compte ne possède pas le rôle <strong>Modérateur</strong> requis pour accéder au Panel Staff.</p>
                        <a href="/login.html">Retourner au Login</a>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (error) {
        console.error("Erreur vérification rôle :", error);
        req.session.destroy();
        return res.redirect('/login.html');
    }
}
 
// -------------------------------------------------------------
// FLUX D'AUTHENTIFICATION OAUTH2 DISCORD
// -------------------------------------------------------------
app.get('/auth/discord', (req, res) => {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});
 
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Erreur : Code de connexion manquant.");
 
    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
 
        const tokenData = await tokenResponse.json();
        if (tokenData.error) {
            console.error("Erreur Token Discord :", tokenData);
            return res.send("Erreur d'authentification.");
        }
 
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();
 
        // Sauvegarde de l'ID utilisateur dans la session
        req.session.user = {
            id: userData.id,
            username: userData.username
        };
 
        console.log(`🔑 Tentative de connexion de : ${userData.username}`);
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.send("Erreur interne du serveur lors de la connexion.");
    }
});
 
app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});
 
// -------------------------------------------------------------
// PAGES DU SITE WEB (PROTÉGÉES EN DIRECT)
// -------------------------------------------------------------
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
 
app.get('/index.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
 
app.get('/warns.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'warns.html'));
});
 
app.get('/bans.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'bans.html'));
});
 
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
 
// -------------------------------------------------------------
// ROUTES DE L'API (PROTÉGÉES EN DIRECT)
// -------------------------------------------------------------
app.get('/api/sanctions/mutes', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM mutes ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.get('/api/sanctions/warns', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM warns ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.get('/api/sanctions/bans', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bans ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.delete('/api/sanctions/:table/:id', requireAuth, async (req, res) => {
    const { table, id } = req.params;
    if (!['mutes', 'warns', 'bans'].includes(table)) return res.status(400).json({ error: "Table invalide" });
 
    try {
        const dataQuery = await pool.query(`SELECT user_id FROM ${table} WHERE id = $1`, [id]);
        
        if (dataQuery.rows.length > 0) {
            const userIdDiscord = dataQuery.rows[0].user_id;
            const guild = client.guilds.cache.get(GUILD_ID);
 
            if (guild) {
                if (table === 'mutes') {
                    try {
                        const member = await guild.members.fetch(userIdDiscord).catch(() => null);
                        if (member && member.communicationDisabledUntilTimestamp) {
                            await member.timeout(null, "Sanction retirée du site");
                        }
                    } catch { console.log("Impossible d'unmute sur Discord."); }
                } else if (table === 'bans') {
                    try { await guild.bans.remove(userIdDiscord, "Sanction retirée du site"); } catch { console.log("Impossible d'unban."); }
                }
            }
        }
 
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
 
// -------------------------------------------------------------
// DÉMARRAGE DU SERVEUR
// -------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`🚀 Serveur actif sur le port ${PORT}`);
});
