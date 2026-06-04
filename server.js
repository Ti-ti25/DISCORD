const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Distribue tes pages HTML (index.html, warns.html, bans.html, ajouter.html)
app.use(express.static(__dirname));

// Connexion à ta NOUVELLE base de données Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Création automatique des tables SQL
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS mutes (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                user_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                moderator TEXT NOT NULL,
                duration TEXT NOT NULL,
                date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS warns (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                user_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                moderator TEXT NOT NULL,
                date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS bans (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                user_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                moderator TEXT NOT NULL,
                date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Base de données Discord initialisée avec succès ! 🛡️");
    } catch (err) {
        console.error("Erreur d'initialisation SQL :", err);
    }
};
initDb();

// Route pour afficher la page des Mutes (accueil)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route API pour récupérer les données de la base SQL
app.get('/api/sanctions/:type', async (req, res) => {
    const type = req.params.type;
    if (!['mutes', 'warns', 'bans'].includes(type)) return res.status(400).json({ error: "Type invalide" });

    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route API pour ajouter une sanction depuis ajouter.html
app.post('/api/sanctions', async (req, res) => {
    const { type, username, user_id, reason, moderator, duration } = req.body;

    try {
        if (type === 'mute') {
            await pool.query(
                'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                [username, user_id, reason, moderator, duration || 'Non spécifiée']
            );
        } else if (type === 'warn') {
            await pool.query(
                'INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                [username, user_id, reason, moderator]
            );
        } else if (type === 'ban') {
            await pool.query(
                'INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                [username, user_id, reason, moderator]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur Discord lancé sur le port ${PORT} 🚀`);
});