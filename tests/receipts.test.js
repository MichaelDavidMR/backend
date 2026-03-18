const request = require('supertest');
const { app, db } = require('../server');

describe('Receipts API', () => {
  beforeEach(async () => {
    await db.read();
    // Reset to known state for tests
    db.data = {
      clients: [
        { id: 'C-TEST', name: 'Test Client', phone: '000-000-0000', createdAt: new Date().toISOString() }
      ],
      services: [
        { id: 'S-TEST', name: 'Test Service', price: 1000, createdAt: new Date().toISOString() }
      ],
      receipts: [],
      counters: { receipt: 0, client: 1, service: 1 }
    };
    await db.write();
  });

  describe('POST /api/receipts', () => {
    it('should create a new receipt', async () => {
      const receiptData = {
        clientId: 'C-TEST',
        items: [
          { description: 'Test Item', qty: 2, unitPrice: 500 }
        ],
        paymentMethod: 'Efectivo',
        notes: 'Test receipt'
      };

      const response = await request(app)
        .post('/api/receipts')
        .send(receiptData)
        .expect(201);

      expect(response.body.id).toMatch(/^R-\d{4}$/);
      expect(response.body.clientId).toBe('C-TEST');
      expect(response.body.total).toBe(1000);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].subtotal).toBe(1000);
    });

    it('should reject receipt without clientId', async () => {
      const receiptData = {
        items: [{ description: 'Test', qty: 1, unitPrice: 100 }],
        paymentMethod: 'Efectivo'
      };

      await request(app)
        .post('/api/receipts')
        .send(receiptData)
        .expect(400);
    });

    it('should reject receipt without items', async () => {
      const receiptData = {
        clientId: 'C-TEST',
        items: [],
        paymentMethod: 'Efectivo'
      };

      await request(app)
        .post('/api/receipts')
        .send(receiptData)
        .expect(400);
    });

    it('should calculate totals correctly with tax and discount', async () => {
      const receiptData = {
        clientId: 'C-TEST',
        items: [
          { description: 'Item 1', qty: 1, unitPrice: 2000 },
          { description: 'Item 2', qty: 2, unitPrice: 500 }
        ],
        paymentMethod: 'Tarjeta',
        tax: 540,
        discount: 300
      };

      const response = await request(app)
        .post('/api/receipts')
        .send(receiptData)
        .expect(201);

      // Items total: 2000 + 1000 = 3000
      // Subtotal: 3000 - 300 = 2700
      // Total: 2700 + 540 = 3240
      expect(response.body.subtotal).toBe(2700);
      expect(response.body.total).toBe(3240);
    });
  });

  describe('GET /api/receipts', () => {
    it('should list receipts', async () => {
      // Create a test receipt first
      await db.read();
      db.data.counters.receipt++;
      db.data.receipts.push({
        id: 'R-0001',
        clientId: 'C-TEST',
        items: [{ description: 'Test', qty: 1, unitPrice: 100, subtotal: 100 }],
        subtotal: 100,
        tax: 0,
        discount: 0,
        total: 100,
        paymentMethod: 'Efectivo',
        createdAt: new Date().toISOString(),
        anulled: false
      });
      await db.write();

      const response = await request(app)
        .get('/api/receipts')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('R-0001');
    });
  });

  describe('GET /api/receipts/:id', () => {
    it('should get a single receipt with client info', async () => {
      // Create a test receipt
      await db.read();
      db.data.counters.receipt++;
      db.data.receipts.push({
        id: 'R-0001',
        clientId: 'C-TEST',
        items: [{ description: 'Test', qty: 1, unitPrice: 100, subtotal: 100 }],
        subtotal: 100,
        tax: 0,
        discount: 0,
        total: 100,
        paymentMethod: 'Efectivo',
        createdAt: new Date().toISOString(),
        anulled: false
      });
      await db.write();

      const response = await request(app)
        .get('/api/receipts/R-0001')
        .expect(200);

      expect(response.body.id).toBe('R-0001');
      expect(response.body.client).toBeDefined();
      expect(response.body.client.name).toBe('Test Client');
    });

    it('should return 404 for non-existent receipt', async () => {
      await request(app)
        .get('/api/receipts/R-9999')
        .expect(404);
    });
  });

  describe('POST /api/receipts/:id/anull', () => {
    it('should anull a receipt', async () => {
      // Create a test receipt
      await db.read();
      db.data.counters.receipt++;
      db.data.receipts.push({
        id: 'R-0001',
        clientId: 'C-TEST',
        items: [{ description: 'Test', qty: 1, unitPrice: 100, subtotal: 100 }],
        subtotal: 100,
        tax: 0,
        discount: 0,
        total: 100,
        paymentMethod: 'Efectivo',
        createdAt: new Date().toISOString(),
        anulled: false
      });
      await db.write();

      const response = await request(app)
        .post('/api/receipts/R-0001/anull')
        .send({ reason: 'Error en facturación' })
        .expect(200);

      expect(response.body.anulled).toBe(true);
      expect(response.body.anulledReason).toBe('Error en facturación');
      expect(response.body.anulledAt).toBeDefined();
    });
  });
});

describe('Clients API', () => {
  beforeEach(async () => {
    await db.read();
    db.data = {
      clients: [],
      services: [],
      receipts: [],
      counters: { receipt: 0, client: 0, service: 0 }
    };
    await db.write();
  });

  it('should create a new client', async () => {
    const clientData = {
      name: 'Nuevo Cliente',
      phone: '809-555-9999',
      address: 'Test Address'
    };

    const response = await request(app)
      .post('/api/clients')
      .send(clientData)
      .expect(201);

    expect(response.body.id).toMatch(/^C-\d{4}$/);
    expect(response.body.name).toBe('Nuevo Cliente');
  });

  it('should list all clients', async () => {
    await request(app)
      .get('/api/clients')
      .expect(200);
  });
});

describe('Services API', () => {
  beforeEach(async () => {
    await db.read();
    db.data = {
      clients: [],
      services: [],
      receipts: [],
      counters: { receipt: 0, client: 0, service: 0 }
    };
    await db.write();
  });

  it('should create a new service', async () => {
    const serviceData = {
      name: 'Nuevo Servicio',
      price: 2500,
      description: 'Descripción del servicio'
    };

    const response = await request(app)
      .post('/api/services')
      .send(serviceData)
      .expect(201);

    expect(response.body.id).toMatch(/^S-\d{4}$/);
    expect(response.body.price).toBe(2500);
  });
});
