const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');
const session = require('express-session');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
// -------------------------------------------------------------
// SESSION (nécessaire pour l'OAuth2)
// -------------------------------------------------------------
app.use(session({
    secret: process.env.SESSION_SECRET || 'changeme_super_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true sur Render (HTTPS)
        maxAge: 1000 * 60 * 60 * 24 // 24h
    }
}));
 
// Les fichiers statiques sont servis APRÈS le middleware de session
app.use(express.static(__dirname));
 
// -------------------------------------------------------------
// VARIABLES D'ENVIRONNEMENT
// -------------------------------------------------------------
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // ex: https://ton-app.onrender.com/auth/callback
 
// Rôle(s) autorisés à accéder au site (insensible à la casse)
const ALLOWED_ROLES = ['* Modérateur [Discord]'];
 
// -------------------------------------------------------------
// 1. BASE DE DONNÉES POSTGRESQL
// -------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
 
// -------------------------------------------------------------
// 2. BOT DISCORD
// -------------------------------------------------------------
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});
 
const commands = [
    {
        name: 'warn',
        description: 'Mettre un avertissement à un membre, l\'avertir en MP et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à avertir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison de l\'avertissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'mute',
        description: 'Rendre muet (Timeout) un membre sur Discord et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à rendre muet', type: ApplicationCommandOptionType.User, required: true },
            { name: 'duree', description: 'La durée du mute (ex: 15m, 2h, 2h15m, 1d12h)', type: ApplicationCommandOptionType.String, required: true },
            { name: 'motif', description: 'La raison du mute', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'ban',
        description: 'Bannir définitivement un membre de Discord et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à bannir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison du bannissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    }
];
 
discordClient.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${discordClient.user.tag} !`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(discordClient.user.id), { body: [] });
        await rest.put(Routes.applicationCommands(discordClient.user.id), { body: commands });
        console.log('✅ Commandes Slash synchronisées !');
    } catch (error) {
        console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
    }
});
 
discordClient.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
 
    const { commandName } = interaction;
    const targetMember = interaction.options.getMember('membre');
    const reason = interaction.options.getString('motif');
 
    if (!targetMember) {
        return interaction.reply({ content: "❌ Impossible de trouver ce membre sur le serveur.", ephemeral: true });
    }
 
    const moderator = interaction.user.tag;
    const username = targetMember.user.username;
    const user_id = targetMember.id;
 
    // --- /WARN ---
    if (commandName === 'warn') {
        await interaction.deferReply();
        let mpEnvoye = true;
        try {
            await targetMember.send(`⚠️ **Avertissement reçu**\n\nTu as reçu un avertissement sur le serveur.\n**Raison :** ${reason}\n**Modérateur :** ${moderator}\n\n*Cet avertissement a été consigné dans ton casier judiciaire sur notre site web.*`);
        } catch {
            console.log(`⚠️ Impossible d'envoyer un MP à ${username}.`);
            mpEnvoye = false;
        }
        try {
            await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            if (mpEnvoye) {
                return interaction.editReply(`⚠️ **${username}** a reçu un avertissement, a été notifié en MP, et cela apparaît sur le site web !`);
            } else {
                return interaction.editReply(`⚠️ **${username}** a reçu un avertissement et apparaît sur le site web ! *(Note : MP fermés).*`);
            }
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur de base de données.");
        }
    }
 
    // --- /MUTE ---
    if (commandName === 'mute') {
        const timeArg = interaction.options.getString('duree').toLowerCase().trim();
        await interaction.deferReply();
        try {
            let totalMs = 0;
            const daysMatch = timeArg.match(/(\d+)d/);
            const hoursMatch = timeArg.match(/(\d+)h/);
            const minsMatch = timeArg.match(/(\d+)m/);
 
            if (daysMatch) totalMs += parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
            if (hoursMatch) totalMs += parseInt(hoursMatch[1]) * 60 * 60 * 1000;
            if (minsMatch) totalMs += parseInt(minsMatch[1]) * 60 * 1000;
 
            if (totalMs === 0) return interaction.editReply("❌ Format invalide ! Exemple : `15m`, `2h`, `2h15m`, `1d12h`.");
 
            let durationParts = [];
            if (daysMatch) durationParts.push(`${daysMatch[1]} Jour(s)`);
            if (hoursMatch) durationParts.push(`${hoursMatch[1]} Heure(s)`);
            if (minsMatch) durationParts.push(`${minsMatch[1]} Minute(s)`);
            const durationText = durationParts.join(' et ');
 
            await targetMember.timeout(totalMs, reason);
            await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, durationText]);
            return interaction.editReply(`🔇 **${username}** a été muté pendant **${durationText}** sur Discord et ajouté au site !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur lors du mute. Vérifie ma hiérarchie.");
        }
    }
 
    // --- /BAN ---
    if (commandName === 'ban') {
        await interaction.deferReply();
        try {
            await targetMember.ban({ reason });
            await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            return interaction.editReply(`🔨 **${username}** a été banni de Discord et ajouté au site web !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Impossible de bannir ce membre.");
        }
    }
});
 
discordClient.login(process.env.DISCORD_TOKEN);
 
// -------------------------------------------------------------
// 3. OAUTH2 DISCORD — ROUTES D'AUTHENTIFICATION
// -------------------------------------------------------------
 
// Middleware de protection : vérifie que l'utilisateur est connecté et autorisé
function requireAuth(req, res, next) {
    if (!req.session.user) {
        // Si c'est une requête API, renvoyer 401
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Non authentifié.' });
        }
        // Sinon rediriger vers la page de login
        return res.redirect('/login.html');
    }
    next();
}
 
// Route : démarrer la connexion OAuth2
app.get('/auth/login', (req, res) => {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'identify guilds.members.read'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});
 
// Route : callback OAuth2 après connexion Discord
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/login.html?error=no_code');
 
    try {
        // 1. Échanger le code contre un token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI
            })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return res.redirect('/login.html?error=token_failed');
 
        // 2. Récupérer les infos de l'utilisateur
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userRes.json();
 
        // 3. Vérifier que l'utilisateur est membre du serveur ET a le bon rôle
        const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
 
        if (!memberRes.ok) {
            console.log(`❌ ${userData.username} n'est pas membre du serveur.`);
            return res.redirect('/login.html?error=not_member');
        }
 
        const memberData = await memberRes.json();
 
        // 4. Récupérer les noms des rôles via le bot (qui a accès au serveur)
        let hasAccess = false;
        try {
            const guild = await discordClient.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(userData.id);
 
            hasAccess = member.roles.cache.some(role =>
                ALLOWED_ROLES.some(allowed => role.name.toLowerCase() === allowed.toLowerCase())
            );
        } catch (roleErr) {
            console.error('Erreur vérification des rôles via le bot :', roleErr);
            // Fallback : vérifier via les role IDs retournés par OAuth (sans les noms)
            // Dans ce cas on refuse par sécurité
            hasAccess = false;
        }
 
        if (!hasAccess) {
            console.log(`⛔ ${userData.username} n'a pas le rôle requis.`);
            return res.redirect('/login.html?error=no_permission');
        }
 
        // 5. Stocker les infos en session
        req.session.user = {
            id: userData.id,
            username: userData.username,
            discriminator: userData.discriminator,
            avatar: userData.avatar
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/${parseInt(userData.discriminator) % 5}.png`
        };
 
        console.log(`✅ ${userData.username} connecté avec succès.`);
        return res.redirect('/');
 
    } catch (err) {
        console.error('Erreur OAuth2 :', err);
        return res.redirect('/login.html?error=server_error');
    }
});
 
// Route : déconnexion
app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login.html');
    });
});
 
// Route : infos de l'utilisateur connecté (utilisé par le front)
app.get('/api/me', requireAuth, (req, res) => {
    res.json(req.session.user);
});
 
// -------------------------------------------------------------
// 4. SITE WEB — ROUTES PROTÉGÉES
// -------------------------------------------------------------
 
// Page principale protégée
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
 
// Page de login (accessible sans auth)
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
 
// API sanctions — protégées
app.get('/api/sanctions/:type', requireAuth, async (req, res) => {
    let type = req.params.type.toLowerCase();
    if (type.endsWith('s')) type = type.slice(0, -1);
    const dbTable = type + 's';
 
    try {
        const result = await pool.query(`SELECT * FROM ${dbTable} ORDER BY date_added DESC`);
        let rows = result.rows;
 
        if (type === 'mute' && GUILD_ID) {
            const guild = await discordClient.guilds.fetch(GUILD_ID).catch(() => null);
            if (guild) {
                for (const row of rows) {
                    const member = await guild.members.fetch(row.user_id).catch(() => null);
                    if (!member || !member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp < Date.now()) {
                        await pool.query('DELETE FROM mutes WHERE id = $1', [row.id]);
                    }
                }
                const updatedResult = await pool.query('SELECT * FROM mutes ORDER BY date_added DESC');
                rows = updatedResult.rows;
            }
        }
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
 
app.post('/api/sanctions', requireAuth, async (req, res) => {
    let { type, username, user_id, reason, moderator, duration } = req.body;
    type = type.toLowerCase();
    if (type.endsWith('s')) type = type.slice(0, -1);
 
    try {
        if (type === 'mute') await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, duration || 'Non spécifiée']);
        else if (type === 'warn') await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        else if (type === 'ban') await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
 
app.delete('/api/sanctions/:table/:id', requireAuth, async (req, res) => {
    const { table, id } = req.params;
    console.log(`🗑️ Suppression demandée : table ${table}, ID ${id}`);
 
    try {
        const data = await pool.query(`SELECT user_id FROM ${table} WHERE id = $1`, [id]);
        if (data.rows.length > 0) {
            const userIdDiscord = data.rows[0].user_id;
 
            if (GUILD_ID) {
                const guild = await discordClient.guilds.fetch(GUILD_ID).catch(() => null);
                if (guild) {
                    if (table === 'mutes' || table === 'mute') {
                        try {
                            const member = await guild.members.fetch(userIdDiscord).catch(() => null);
                            if (member && member.communicationDisabledUntilTimestamp) {
                                await member.timeout(null, "Sanction annulée depuis le site web");
                                console.log(`🔊 Unmute appliqué pour ${member.user.username}`);
                            }
                        } catch { console.log("⚠️ Impossible d'unmute sur Discord."); }
                    } else if (table === 'bans' || table === 'ban') {
                        try {
                            await guild.bans.remove(userIdDiscord, "Sanction annulée depuis le site web");
                            console.log(`🔓 Unban appliqué pour l'ID ${userIdDiscord}`);
                        } catch { console.log("⚠️ Impossible d'unban sur Discord."); }
                    }
                }
            }
        }
 
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        console.log(`✅ Ligne ID ${id} supprimée de ${table}.`);
        return res.json({ success: true });
    } catch (err) {
        console.error("❌ Erreur suppression :", err);
        return res.status(500).json({ error: err.message });
    }
});
 
// -------------------------------------------------------------
// 5. DÉMARRAGE DU SERVEUR
// -------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});
 
