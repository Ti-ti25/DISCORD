const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// -------------------------------------------------------------
// 1. BASE DE DONNÉES POSTGRESQL (RENDER)
// -------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// -------------------------------------------------------------
// 2. LE BOT DISCORD & ENREGISTREMENT DES COMMANDES SLASH SUR MESURE
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

// Séparation en 3 commandes simples et intuitives
const commands = [
    {
        name: 'warn',
        description: 'Mettre un avertissement à un membre et l\'ajouter au site',
        options: [
            {
                name: 'membre',
                description: 'Le membre à avertir',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'motif',
                description: 'La raison de l\'avertissement',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    },
    {
        name: 'mute',
        description: 'Rendre muet (Timeout) un membre sur Discord et l\'ajouter au site',
        options: [
            {
                name: 'membre',
                description: 'Le membre à rendre muet',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'duree',
                description: 'La durée du mute (ex: 15m, 2h, 1d)',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'motif',
                description: 'La raison du mute',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    },
    {
        name: 'ban',
        description: 'Bannir définitivement un membre de Discord et l\'ajouter au site',
        options: [
            {
                name: 'membre',
                description: 'Le membre à bannir',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'motif',
                description: 'La raison du bannissement',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    }
];

client.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${client.user.tag} !`);

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        console.log('🔄 Enregistrement des nouvelles commandes Slash (/warn, /mute, /ban)...');
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );

        console.log('✅ Toutes les commandes Slash individuelles sont prêtes !');
    } catch (error) {
        console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
    }
});

// Gestionnaire unique des interactions pour chaque commande
client.on('interactionCreate', async (interaction) => {
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

    // --- COMMANDE /WARN ---
    if (commandName === 'warn') {
        await interaction.deferReply();
        try {
            await pool.query(
                'INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                [username, user_id, reason, moderator]
            );
            return interaction.editReply(`⚠️ **${username}** a reçu un avertissement et cela apparaît sur le site web !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur lors de l'enregistrement du warn dans la base de données.");
        }
    }

    // --- COMMANDE /MUTE ---
    if (commandName === 'mute') {
        const timeArg = interaction.options.getString('duree');
        await interaction.deferReply();

        try {
            let ms = 0;
            let durationText = "";
            const timeValue = parseInt(timeArg);
            const timeUnit = timeArg.slice(-1).toLowerCase();

            if (timeUnit === 'm') {
                ms = timeValue * 60 * 1000;
                durationText = `${timeValue} Minute(s)`;
            } else if (timeUnit === 'h') {
                ms = timeValue * 60 * 60 * 1000;
                durationText = `${timeValue} Heure(s)`;
            } else if (timeUnit === 'd') {
                ms = timeValue * 24 * 60 * 60 * 1000;
                durationText = `${timeValue} Jour(s)`;
            }

            if (ms === 0 || isNaN(timeValue)) {
                return interaction.editReply("❌ Format de durée invalide ! Utilise par exemple : `15m`, `2h`, ou `1d`.");
            }

            // Application du vrai mute sur Discord
            await targetMember.timeout(ms, reason);

            // Envoi au site web
            await pool.query(
                'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                [username, user_id, reason, moderator, durationText]
            );
            return interaction.editReply(`🔇 **${username}** a été muté pendant **${durationText}** sur Discord et ajouté au site !`);

        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur lors du mute. Vérifie les permissions de mon rôle.");
        }
    }

    // --- COMMANDE /BAN ---
    if (commandName === 'ban') {
        await interaction.deferReply();
        try {
            // Application du vrai ban sur Discord
            await targetMember.ban({ reason: reason });

            // Envoi au site web
            await pool.query(
                'INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                [username, user_id, reason, moderator]
            );
            return interaction.editReply(`🔨 **${username}** a été banni de Discord et ajouté au site web !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur. Impossible de bannir ce membre (Hiérarchie des rôles incorrecte).");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// -------------------------------------------------------------
// 3. SITE WEB API (ROUTES POUR LES PAGES HTML)
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/sanctions/:type', async (req, res) => {
    const type = req.params.type;
    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sanctions', async (req, res) => {
    const { type, username, user_id, reason, moderator, duration } = req.body;
    try {
        if (type === 'mute') {
            await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, duration || 'Non spécifiée']);
        } else if (type === 'warn') {
            await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        } else if (type === 'ban') {
            await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sanctions/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        await pool.query(`DELETE FROM ${type} WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur en ligne sur le port ${PORT} 🚀`);
});