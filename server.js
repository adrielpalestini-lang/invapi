const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

/* =========================
   CONEXIÓN COMERCIAL (PRODUCTOS)
========================= */
const comercialPool = new Pool({
    user: process.env.DB_COMERCIAL_USER,
    host: process.env.DB_COMERCIAL_HOST,
    database: process.env.DB_COMERCIAL_NAME,
    password: process.env.DB_COMERCIAL_PASSWORD,
    port: 5432,
    ssl: { rejectUnauthorized: false }
});

/* =========================
   CONEXIÓN TIENDA (INVENTARIO)
========================= */
const tiendaPool = new Pool({
    user: process.env.DB_TIENDA_USER,
    host: process.env.DB_TIENDA_HOST,
    database: process.env.DB_TIENDA_NAME,
    password: process.env.DB_TIENDA_PASSWORD,
    port: 5432,
    ssl: { rejectUnauthorized: false }
});


app.get('/health', async (req, res) => {
    res.json({
        ok: true,
        puerto: process.env.PORT,
        tiendaHost: process.env.DB_TIENDA_HOST,
        comercialHost: process.env.DB_COMERCIAL_HOST
    });
});

app.get('/test-db', async (req, res) => {
    try {
        const result = await tiendaPool.query('SELECT NOW()');
        res.json({
            ok: true,
            fecha: result.rows[0]
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

/* =========================
   1. ESTADO CORRIDA
========================= */
app.get('/estado-corrida', async (req, res) => {
    try {
        const result = await tiendaPool.query(
            'SELECT id, activa FROM corridas ORDER BY id DESC LIMIT 1'
        );

        if (result.rows.length > 0 && result.rows[0].activa) {
            res.json({ activa: true, id_corrida: result.rows[0].id });
        } else {
            res.json({ activa: false });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   2. INICIAR CORRIDA
========================= */
app.post('/iniciar-corrida', async (req, res) => {
    try {
        await tiendaPool.query('UPDATE corridas SET activa = FALSE WHERE activa = TRUE');
        await tiendaPool.query('INSERT INTO corridas (activa) VALUES (TRUE)');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   3. FINALIZAR CORRIDA
========================= */
app.post('/finalizar-corrida', async (req, res) => {
    try {
        await tiendaPool.query(`
            UPDATE corridas 
            SET activa = FALSE, fecha_fin = CURRENT_TIMESTAMP 
            WHERE activa = TRUE
        `);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   4. BUSCAR PRODUCTOS (COMERCIAL DB)
========================= */
app.get('/buscar-nombre', async (req, res) => {
    const term = req.query.q;

    try {
        const result = await comercialPool.query(
            'SELECT sku, name FROM products WHERE name ILIKE $1 LIMIT 15',
            [`%${term}%`]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   5. CONSULTAR PRODUCTO + DUPLICADO
========================= */
app.get('/consultar/:codigo/:almacen', async (req, res) => {
    const { codigo, almacen } = req.params;

    try {
        // validar producto en catálogo
        const prod = await comercialPool.query(
            'SELECT name FROM products WHERE sku = $1',
            [codigo]
        );

        if (prod.rows.length === 0) {
            return res.json({ existe: false });
        }

        // duplicado en corrida activa
        const dup = await tiendaPool.query(`
            SELECT usuario 
            FROM inventario 
            WHERE codigo = $1 AND almacen = $2 
            AND id_corrida = (
                SELECT id FROM corridas 
                WHERE activa = TRUE 
                ORDER BY id DESC LIMIT 1
            )
        `, [codigo, almacen]);

        res.json({
            existe: true,
            nombre: prod.rows[0].name,
            repetido: dup.rows.length > 0,
            mensajeRepetido: dup.rows.length > 0
                ? `Ya registrado por ${dup.rows[0].usuario}`
                : ""
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   6. GUARDAR INVENTARIO
========================= */
app.post('/guardar', async (req, res) => {
    const { codigo, nombre, cantidad, almacen, usuario } = req.body;

    try {
        await tiendaPool.query(`
            INSERT INTO inventario 
            (codigo, nombre, cantidad, almacen, usuario, id_corrida)
            VALUES ($1, $2, $3, $4, $5,
            (SELECT id FROM corridas WHERE activa = TRUE ORDER BY id DESC LIMIT 1))
        `, [codigo, nombre, cantidad, almacen, usuario]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   7. BORRAR CAPTURA
========================= */
app.post('/borrar-captura', async (req, res) => {
    const { codigo, almacen } = req.body;

    try {
        await tiendaPool.query(`
            DELETE FROM inventario 
            WHERE codigo = $1 AND almacen = $2 
            AND id_corrida = (
                SELECT id FROM corridas 
                WHERE activa = TRUE 
                ORDER BY id DESC LIMIT 1
            )
        `, [codigo, almacen]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   8. EXPORTAR CSV
========================= */
app.get('/exportar-csv/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await tiendaPool.query(`
            SELECT 
                i.almacen,
                i.codigo,
                i.nombre,
                SUM(i.cantidad) as cantidad_total,
                STRING_AGG(DISTINCT i.usuario, ', ') as usuarios_lista,
                MAX(i.fecha) as fecha_final,
                CASE WHEN p.sku IS NULL THEN 'SÍ' ELSE 'NO' END as es_nuevo
            FROM inventario i
            LEFT JOIN products p ON i.codigo = p.sku
            WHERE i.id_corrida = $1
            GROUP BY i.almacen, i.codigo, i.nombre, p.sku
            ORDER BY es_nuevo ASC, i.almacen ASC, i.nombre ASC
        `, [id]);

        const header = "Almacen,Codigo,Nombre,Cantidad Total,Usuarios,Ultimo Registro,Nuevo\n";

        const rows = result.rows.map(r => {
            const fecha = r.fecha_final
                ? new Date(r.fecha_final).toISOString().replace('T', ' ').split('.')[0]
                : '---';

            return `${r.almacen},"${r.codigo}","${r.nombre}",${r.cantidad_total},"${r.usuarios_lista}",${fecha},${r.es_nuevo}`;
        }).join("\n");

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=inventario_${id}.csv`);
        res.send('\uFEFF' + header + rows);

    } catch (err) {
        res.status(500).send("Error exportando CSV");
    }
});

/* =========================
   9. USUARIOS
========================= */
app.get('/usuarios-list', async (req, res) => {
    const result = await tiendaPool.query(
        'SELECT * FROM usuarios_app ORDER BY nombre ASC'
    );
    res.json(result.rows);
});

app.post('/usuarios-add', async (req, res) => {
    const { nombre } = req.body;
    await tiendaPool.query(
        'INSERT INTO usuarios_app (nombre) VALUES ($1)',
        [nombre]
    );
    res.json({ success: true });
});

app.post('/usuarios-delete', async (req, res) => {
    const { id } = req.body;
    await tiendaPool.query(
        'DELETE FROM usuarios_app WHERE id = $1',
        [id]
    );
    res.json({ success: true });
});

/* =========================
   10. ALMACENES
========================= */
app.get('/almacenes-list', async (req, res) => {
    const result = await tiendaPool.query(
        'SELECT * FROM almacenes_app ORDER BY nombre ASC'
    );
    res.json(result.rows);
});

app.post('/almacenes-add', async (req, res) => {
    const { nombre } = req.body;
    await tiendaPool.query(
        'INSERT INTO almacenes_app (nombre) VALUES ($1)',
        [nombre]
    );
    res.json({ success: true });
});

app.post('/almacenes-delete', async (req, res) => {
    const { id } = req.body;
    await tiendaPool.query(
        'DELETE FROM almacenes_app WHERE id = $1',
        [id]
    );
    res.json({ success: true });
});

/* =========================
   11. CORRIDAS
========================= */
app.get('/corridas', async (req, res) => {
    try {
        const result = await tiendaPool.query(
            'SELECT id, fecha_inicio, activa FROM corridas ORDER BY id DESC'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 8080;

app.listen(PORT, () =>
    console.log(`🚀 API lista en puerto ${PORT}`)
);