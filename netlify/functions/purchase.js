const fetch = require('node-fetch');
const { Client } = require('pg');
const HttpsProxyAgent = require('https-proxy-agent');

// KEYS & CONFIG
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY; 
const DATABASE_URL = process.env.DATABASE_URL;
const QUOTAGUARD_URL = process.env.QUOTAGUARD_URL; 

// MAPS
const PLAN_MAP = {
    'mtn-1gb': 1001, 'mtn-2gb': 6666, 'mtn-5gb': 9999, 'mtn-10gb': 1110,
    'glo-1gb': 206, 'glo-5gb': 222, 'glo-10gb': 512
};
const PRICE_MAP = {
    'mtn-1gb': 500, 'mtn-2gb': 1000, 'mtn-5gb': 2000, 'mtn-10gb': 4000,
    'glo-1gb': 500, 'glo-5gb': 2500
};
const NETWORK_MAP = { 'mtn': 1, 'glo': 2 };

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let client;
    try {
        const data = JSON.parse(event.body);
        const { transaction_id, tx_ref, mobile_number, network, plan_id, ported } = data;

        if (!transaction_id || !mobile_number) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing details' }) };
        }

        // 1. Connect DB
        client = new Client({ connectionString: DATABASE_URL, ssl: true });
        await client.connect();

        // 2. IDEMPOTENCY CHECK
        const checkRes = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(transaction_id)]);
        if (checkRes.rows.length > 0) {
            await client.end();
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Transaction already processed' }) };
        }

        // 3. VERIFY PAYMENT WITH FLUTTERWAVE
        const flwResponse = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${FLW_SECRET_KEY}`
            }
        });
        const flwData = await flwResponse.json();

        if (flwData.status !== 'success' || flwData.data.status !== 'successful') {
            await client.end();
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Payment verification failed' }) };
        }

        const expectedPrice = PRICE_MAP[plan_id];
        if (flwData.data.amount < expectedPrice) {
            await client.end();
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Amount paid is less than plan price' }) };
        }

        // 4. DISPENSE DATA VIA AMIGO
        const payload = {
            network: NETWORK_MAP[network],
            mobile_number: mobile_number,
            plan: PLAN_MAP[plan_id],
            Ported_number: !!ported
        };

        const proxyOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
            body: JSON.stringify(payload)
        };

        if (QUOTAGUARD_URL) {
            proxyOptions.agent = new HttpsProxyAgent(QUOTAGUARD_URL);
            console.log("Proxy enabled for Amigo API call");
        }

        const amigoRes = await fetch('https://amigo.ng/api/data/', proxyOptions);
        const amigoResult = await amigoRes.json();

        // 5. SAVE TRANSACTION TO DB
        const status = amigoResult.success ? 'success' : 'failed';
        await client.query(
            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [mobile_number, network, plan_id, status, String(transaction_id), JSON.stringify(amigoResult)]
        );

        await client.end();

        if (amigoResult.success) {
            return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Data Sent Successfully!' }) };
        } else {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Payment received, but Data failed: ' + amigoResult.message }) };
        }

    } catch (e) {
        if(client) await client.end();
        console.error(e);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: e.message }) };
    }
};
