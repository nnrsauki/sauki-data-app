const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; 

exports.handler = async (event) => {
    // 1. Verify Signature
    const signature = event.headers['verif-hash'];
    if (!signature || signature !== FLW_SECRET_HASH) {
        return { statusCode: 401, body: 'Unverified' };
    }

    try {
        const body = JSON.parse(event.body);

        // 2. Only handle successful charges
        if (body.event === 'charge.completed' && body.data.status === 'successful') {
            const txData = body.data;
            const client = new Client({ connectionString: DATABASE_URL, ssl: true });
            await client.connect();

            // 3. Log transaction or handle redundant processing
            // In a production system, you could duplicate the Amigo dispensing logic here 
            // to ensure data is sent even if the user closes their browser early.
            console.log(`Webhook received for ${txData.id}`);

            await client.end();
        }

        return { statusCode: 200, body: 'OK' };
    } catch (e) {
        console.error(e);
        return { statusCode: 500, body: 'Server Error' };
    }
};
