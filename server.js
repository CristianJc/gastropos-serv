const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const cors = require("cors");

const db = new sqlite3.Database('./restaurant.db');
const ORDER_STATUSES = ['pending', 'preparing', 'ready', 'delivered', 'cancelled'];
const formatDate = (date) => {
    return date.toISOString().split('T')[0];
};
app.use(express.json());
app.use(
  cors({
    origin: "https://gastropos-serv.onrender.com/", // Reemplaza con la URL de tu frontend
    methods: ["GET", "POST", "PUT", "DELETE","PATCH"], // Métodos permitidos
    credentials: false, // Si necesitas enviar cookies o headers personalizados
  })
);
// Database initialization
db.serialize(() => {
    // Productos (menú items)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        category TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Inventario
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY,
        product_id INTEGER,
        quantity INTEGER NOT NULL,
        unit TEXT,
        min_stock INTEGER,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`);

    // Mesas
    db.run(`CREATE TABLE IF NOT EXISTS tables (
        id INTEGER PRIMARY KEY,
        number INTEGER UNIQUE NOT NULL,
        status TEXT DEFAULT 'free' CHECK(status IN ('free', 'occupied', 'reserved'))
    )`);

    // Órdenes
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        table_id INTEGER,
        order_type TEXT CHECK(order_type IN ('table', 'takeout', 'delivery')),
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'preparing', 'ready', 'delivered', 'cancelled')),
        customer_name TEXT,
        total_amount DECIMAL(10,2),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (table_id) REFERENCES tables(id)
    )`);

    // Detalles de órdenes
    db.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER,
        product_id INTEGER,
        quantity INTEGER NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        notes TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`);

     db.run(`CREATE TABLE IF NOT EXISTS facturas (
        id INTEGER PRIMARY KEY,
        orden_id INTEGER NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        cantidad_pagada DECIMAL(10,2) NOT NULL,
        cambio DECIMAL(10,2) NOT NULL,
        fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
        utilidad DECIMAL(10,2) NOT NULL,
        mesa_id INTEGER,
        estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'pagada')),
        metodo_pago TEXT NOT NULL,
        usuario_id INTEGER NOT NULL,
        FOREIGN KEY (orden_id) REFERENCES orders(id),
        FOREIGN KEY (mesa_id) REFERENCES tables(id)
    )`);
});

// API Endpoints

// Productos
app.post('/products', (req, res) => {
    const { name, description, price, category } = req.body;
    db.run(
        'INSERT INTO products (name, description, price, category) VALUES (?, ?, ?, ?)',
        [name, description, price, category],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: "Producto creado exitosamente" });
        }
    );
});

app.get('/products', (req, res) => {
    db.all('SELECT * FROM products', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Inventario
app.post('/inventory', (req, res) => {
    const { product_id, quantity, unit, min_stock } = req.body;
    db.run(
        'INSERT INTO inventory (product_id, quantity, unit, min_stock) VALUES (?, ?, ?, ?)',
        [product_id, quantity, unit, min_stock],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: "Inventario actualizado" });
        }
    );
});
app.get('/inventory', (req, res) => {
   db.all(
    `SELECT inventory.*, products.name AS product_name 
     FROM inventory
     JOIN products ON inventory.product_id = products.id`, 
    [], 
    (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    }
);

});
app.get('/tables', (req, res) => {
    const query = `
        SELECT 
            t.*,
            o.id as order_id,
            o.status as order_status,
            o.total_amount,
            o.created_at as order_created_at
        FROM tables t
        LEFT JOIN (
            SELECT * FROM orders 
            WHERE status NOT IN ('delivered', 'cancelled')
            AND order_type = 'table'
        ) o ON t.id = o.table_id
    `;

  db.all(query, [], (err, tables) => {
    if (err) {
        res.status(500).json({ error: err.message });
        return;
    }

    const tableMap = {};

    // Function to process each table and its orders
    const processTable = async (table) => {
        return new Promise((resolve, reject) => {
            if (!tableMap[table.id]) {
                tableMap[table.id] = {
                    id: table.id,
                    number: table.number,
                    status: table.status,
                    currentOrder: null,
                    orderItems: []
                };
            }

            if (table.order_id) {
                const itemsQuery = `
                    SELECT oi.*, p.name as product_name
                    FROM order_items oi
                    JOIN products p ON p.id = oi.product_id
                    WHERE oi.order_id = ?
                `;
                
                db.all(itemsQuery, [table.order_id], (err, items) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    tableMap[table.id].currentOrder = {
                        id: table.order_id,
                        table_id: table.id,
                        order_type: 'table',
                        status: table.order_status,
                        total_amount: table.total_amount,
                        created_at: table.order_created_at
                    };
                    tableMap[table.id].orderItems = items;
                    resolve(tableMap[table.id]);
                });
            } else {
                resolve(tableMap[table.id]);
            }
        });
    };

    // Process all tables
    Promise.all(tables.map(processTable))
        .then(() => {
            res.json(Object.values(tableMap));
        })
        .catch(error => {
            res.status(500).json({ error: error.message });
        });
});

});

// Create a new order for a table
app.post('/orders', (req, res) => {
    const { table_id, order_type, status, total_amount } = req.body;
    
    // First update table status
    db.run('UPDATE tables SET status = ? WHERE id = ?', 
        ['occupied', table_id], 
        (err) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }

            // Then create the order
            db.run(
                'INSERT INTO orders (table_id, order_type, status, total_amount) VALUES (?, ?, ?, ?)',
                [table_id, order_type, status, total_amount],
                function(err) {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    const order_id = this.lastID;

                    // If there are order items, insert them
                    if (req.body.orderItems && req.body.orderItems.length > 0) {
                        console.log('se inserto order_items')
                        const stmt = db.prepare(
                            'INSERT INTO order_items (order_id, product_id, quantity, price, notes) VALUES (?, ?, ?, ?, ?)'
                        );
                        
                        req.body.orderItems.forEach(item => {
                            stmt.run([order_id, item.product_id, item.quantity, item.price, item.notes || null]);
                        });
                        
                        stmt.finalize((err) => {
                            if (err) {
                                res.status(500).json({ error: err.message });
                                return;
                            }
                            // Return the created order
                            res.json({
                                id: order_id,
                                table_id,
                                order_type,
                                status,
                                total_amount,
                                created_at: new Date().toISOString()
                            });
                        });
                    } else {
                        res.json({
                            id: order_id,
                            table_id,
                            order_type,
                            status,
                            total_amount,
                            created_at: new Date().toISOString()
                        });
                    }
                }
            );
        }
    );
});
app.get('/orders', (req, res) => {
    const { status } = req.query;
    let query = `
        SELECT 
            o.*,
            t.number as table_number
        FROM orders o
        LEFT JOIN tables t ON o.table_id = t.id
    `;
    
    const params = [];
    if (status && ORDER_STATUSES.includes(status)) {
        query += ' WHERE o.status = ?';
        params.push(status);
    }
    
    query += ' ORDER BY o.created_at DESC';

    db.all(query, params, (err, orders) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        // Get order items for each order
        const fetchOrderItems = (order) => {
            return new Promise((resolve, reject) => {
                const itemsQuery = `
                    SELECT 
                        oi.*,
                        p.name as product_name,
                        p.description as product_description
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = ?
                `;
                
                db.all(itemsQuery, [order.id], (err, items) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    order.orderItems = items;
                    resolve(order);
                });
            });
        };

        Promise.all(orders.map(fetchOrderItems))
            .then(ordersWithItems => {
                res.json(ordersWithItems);
            })
            .catch(error => {
                res.status(500).json({ error: error.message });
            });
    });
});
app.get('/orders/not-invoiced', (req, res) => {
  const query = `
    SELECT 
      o.*,
      t.number as table_number
    FROM orders o
    LEFT JOIN tables t ON o.table_id = t.id
    WHERE o.id NOT IN (
      SELECT orden_id FROM facturas
    )
    ORDER BY o.created_at DESC
  `;

  const params = [];

  db.all(query, params, (err, orders) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    // Get order items for each order (same logic as before)
    const fetchOrderItems = (order) => {
      return new Promise((resolve, reject) => {
        const itemsQuery = `
          SELECT 
            oi.*,
            p.name as product_name,
            p.description as product_description
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = ?
        `;

        db.all(itemsQuery, [order.id], (err, items) => {
          if (err) {
            reject(err);
            return;
          }
          order.orderItems = items;
          resolve(order);
        });
      });
    };

    Promise.all(orders.map(fetchOrderItems))
      .then(ordersWithItems => {
        res.json(ordersWithItems);
      })
      .catch(error => {
        res.status(500).json({ error: error.message });
      });
  });
});
// Update table status
app.patch('/tables/:id/status', (req, res) => {
    const { status } = req.body;
    db.run(
        'UPDATE tables SET status = ? WHERE id = ?',
        [status, req.params.id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: "Table status updated successfully" });
        }
    );
});

// Update order status
app.patch('/orders/:id/status', (req, res) => {
    const { status } = req.body;
    
    if (!ORDER_STATUSES.includes(status)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Update order status
        db.run(
            'UPDATE orders SET status = ? WHERE id = ?',
            [status, req.params.id],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    res.status(500).json({ error: err.message });
                    return;
                }

                // If order is delivered or cancelled, free up the table
                if (status === 'delivered' || status === 'cancelled') {
                    db.run(
                        `UPDATE tables 
                         SET status = 'free' 
                         WHERE id IN (
                             SELECT table_id 
                             FROM orders 
                             WHERE id = ?
                         )`,
                        [req.params.id],
                        (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                res.status(500).json({ error: err.message });
                                return;
                            }

                            db.run('COMMIT', (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    res.status(500).json({ error: err.message });
                                    return;
                                }

                                // Return updated order with items
                                const query = `
                                    SELECT 
                                        o.*,
                                        t.number as table_number
                                    FROM orders o
                                    LEFT JOIN tables t ON o.table_id = t.id
                                    WHERE o.id = ?
                                `;

                                db.get(query, [req.params.id], (err, order) => {
                                    if (err) {
                                        res.status(500).json({ error: err.message });
                                        return;
                                    }

                                    const itemsQuery = `
                                        SELECT 
                                            oi.*,
                                            p.name as product_name,
                                            p.description as product_description
                                        FROM order_items oi
                                        JOIN products p ON oi.product_id = p.id
                                        WHERE oi.order_id = ?
                                    `;

                                    db.all(itemsQuery, [req.params.id], (err, items) => {
                                        if (err) {
                                            res.status(500).json({ error: err.message });
                                            return;
                                        }

                                        order.orderItems = items;
                                        res.json(order);
                                    });
                                });
                            });
                        }
                    );
                } else {
                    db.run('COMMIT');
                    res.json({ message: "Order status updated successfully" });
                }
            }
        );
    });
});

// Get order details by ID
app.get('/orders/:id', (req, res) => {
    const query = `
        SELECT 
            o.*,
            t.number as table_number,
            json_group_array(
                json_object(
                    'id', oi.id,
                    'product_id', oi.product_id,
                    'product_name', p.name,
                    'quantity', oi.quantity,
                    'price', oi.price,
                    'notes', oi.notes
                )
            ) as items
        FROM orders o
        LEFT JOIN tables t ON o.table_id = t.id
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        WHERE o.id = ?
        GROUP BY o.id
    `;

    db.get(query, [req.params.id], (err, order) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!order) {
            res.status(404).json({ error: 'Pedido no encontrado' });
            return;
        }
        // Parse items from string to JSON
        order.items = JSON.parse(order.items);
        res.json(order);
    });
});

// Add items to an existing order
app.post('/orders/:id/items', (req, res) => {
    const orderId = req.params.id;
    const { items } = req.body; // Array of {product_id, quantity, price, notes}

    if (!items || !Array.isArray(items)) {
        res.status(400).json({ error: 'Se requiere un array de items' });
        return;
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const stmt = db.prepare(`
            INSERT INTO order_items (order_id, product_id, quantity, price, notes)
            VALUES (?, ?, ?, ?, ?)
        `);

        let hasError = false;
        items.forEach(item => {
            stmt.run(
                [orderId, item.product_id, item.quantity, item.price, item.notes],
                function(err) {
                    if (err) {
                        hasError = true;
                        db.run('ROLLBACK');
                        res.status(500).json({ error: err.message });
                        return;
                    }
                }
            );
        });

        stmt.finalize(err => {
            if (err || hasError) {
                db.run('ROLLBACK');
                if (!hasError) {
                    res.status(500).json({ error: err.message });
                }
                return;
            }

            // Update total amount
            db.run(`
                UPDATE orders 
                SET total_amount = (
                    SELECT SUM(price * quantity) 
                    FROM order_items 
                    WHERE order_id = ?
                )
                WHERE id = ?
            `, [orderId, orderId], function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    res.status(500).json({ error: err.message });
                    return;
                }

                db.run('COMMIT', err => {
                    if (err) {
                        db.run('ROLLBACK');
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    res.json({ message: 'Items agregados exitosamente' });
                });
            });
        });
    });
});

// Update an order item
app.patch('/orders/:orderId/items/:itemId', (req, res) => {
    const { orderId, itemId } = req.params;
    const { quantity, notes } = req.body;

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Update the order item
        db.run(
            'UPDATE order_items SET quantity = ?, notes = ? WHERE id = ? AND order_id = ?',
            [quantity, notes, itemId, orderId],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    res.status(500).json({ error: err.message });
                    return;
                }

                // Update total amount
                db.run(`
                    UPDATE orders 
                    SET total_amount = (
                        SELECT SUM(price * quantity) 
                        FROM order_items 
                        WHERE order_id = ?
                    )
                    WHERE id = ?
                `, [orderId, orderId], function(err) {
                    if (err) {
                        db.run('ROLLBACK');
                        res.status(500).json({ error: err.message });
                        return;
                    }

                    db.run('COMMIT', err => {
                        if (err) {
                            db.run('ROLLBACK');
                            res.status(500).json({ error: err.message });
                            return;
                        }
                        res.json({ message: 'Item actualizado exitosamente' });
                    });
                });
            }
        );
    });
});

// Delete an item from an order
app.delete('/orders/:orderId/items/:itemId', (req, res) => {
    const { orderId, itemId } = req.params;

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run(
            'DELETE FROM order_items WHERE id = ? AND order_id = ?',
            [itemId, orderId],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    res.status(500).json({ error: err.message });
                    return;
                }

                // Update total amount
                db.run(`
                    UPDATE orders 
                    SET total_amount = (
                        SELECT SUM(price * quantity) 
                        FROM order_items 
                        WHERE order_id = ?
                    )
                    WHERE id = ?
                `, [orderId, orderId], function(err) {
                    if (err) {
                        db.run('ROLLBACK');
                        res.status(500).json({ error: err.message });
                        return;
                    }

                    db.run('COMMIT', err => {
                        if (err) {
                            db.run('ROLLBACK');
                            res.status(500).json({ error: err.message });
                            return;
                        }
                        res.json({ message: 'Item eliminado exitosamente' });
                    });
                });
            }
        );
    });
});

// Ruta para crear una nueva factura
app.post('/facturas', (req, res) => {
    const {
        orden_id,
        total,
        cantidad_pagada,
        cambio,
        utilidad,
        mesa_id,
        metodo_pago,
        usuario_id,
        estado
    } = req.body;

    if (!orden_id || !total || !cantidad_pagada || !cambio || !utilidad || !mesa_id || !metodo_pago || !usuario_id) {
        return res.status(400).json({ error: 'Todos los campos son necesarios' });
    }

    const query = `INSERT INTO facturas (orden_id, total, cantidad_pagada, cambio, fecha_hora, utilidad, mesa_id, estado, metodo_pago, usuario_id)
                   VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, 'pagada', ?, ?)`;

    const params = [
        orden_id, 
        total, 
        cantidad_pagada, 
        cambio, 
        utilidad, 
        mesa_id, 
        metodo_pago, 
        usuario_id
    ];

    db.run(query, params, function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.status(201).json({
            message: 'Factura creada exitosamente',
            facturaId: this.lastID
        });
    });
});

// Ruta para listar todas las facturas
app.get('/facturas', (req, res) => {
    const query = `SELECT f.id, f.orden_id, f.total, f.cantidad_pagada, f.cambio, f.fecha_hora, f.utilidad, f.mesa_id, f.estado, f.metodo_pago, f.usuario_id
                   FROM facturas f`;

    db.all(query, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.status(200).json(rows);
    });
});


// Get daily sales report
app.get('/daily-sales', async (req, res) => {
    const date = req.query.date || formatDate(new Date());
    
    const query = `
        SELECT 
            SUM(total) as total_ventas,
            SUM(utilidad) as total_utilidad,
            COUNT(*) as numero_facturas,
            metodo_pago,
            strftime('%Y-%m-%d', fecha_hora) as fecha
        FROM facturas
        WHERE estado = 'pagada'
        AND DATE(fecha_hora) = ?
        GROUP BY metodo_pago, fecha
    `;
    
    db.all(query, [date], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Get sales by date range
app.get('/sales-by-date-range', async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const query = `
        SELECT 
            strftime('%Y-%m-%d', fecha_hora) as fecha,
            SUM(total) as total_ventas,
            SUM(utilidad) as total_utilidad,
            COUNT(*) as numero_facturas
        FROM facturas
        WHERE estado = 'pagada'
        AND DATE(fecha_hora) BETWEEN ? AND ?
        GROUP BY fecha
        ORDER BY fecha
    `;
    
    db.all(query, [startDate, endDate], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Get sales by table
app.get('/sales-by-table', async (req, res) => {
    const { date } = req.query;
    
    const query = `
        SELECT 
            t.number as numero_mesa,
            COUNT(*) as numero_facturas,
            SUM(f.total) as total_ventas,
            SUM(f.utilidad) as total_utilidad
        FROM facturas f
        JOIN tables t ON f.mesa_id = t.id
        WHERE f.estado = 'pagada'
        AND DATE(f.fecha_hora) = ?
        GROUP BY t.number
        ORDER BY t.number
    `;
    
    db.all(query, [date], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Get detailed sales report with products
app.get('/detailed-sales', async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const query = `
        SELECT 
            p.name as producto,
            p.category as categoria,
            SUM(oi.quantity) as cantidad_vendida,
            SUM(oi.quantity * oi.price) as total_ventas
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        JOIN orders o ON oi.order_id = o.id
        JOIN facturas f ON f.orden_id = o.id
        WHERE f.estado = 'pagada'
        AND DATE(f.fecha_hora) BETWEEN ? AND ?
        GROUP BY p.id, p.name, p.category
        ORDER BY total_ventas DESC
    `;
    
    db.all(query, [startDate, endDate], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});
// Iniciar servidor
const PORT = process.env.PORT || 3000; // Usar el puerto proporcionado por Render o el puerto 3000 por defecto

app.listen(PORT, () => {
  console.log(`Servidor POS corriendo en http://localhost:${PORT}`);
});
