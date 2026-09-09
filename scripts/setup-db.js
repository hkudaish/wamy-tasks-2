const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres'
  });

  await client.connect();

  try {
    await client.query("CREATE USER wamy WITH PASSWORD 'WamyLocalDb_8vN4pQ2k' SUPERUSER;");
    console.log('User "wamy" created successfully.');
  } catch (e) {
    if (e.code === '42710') {
      await client.query("ALTER USER wamy WITH PASSWORD 'WamyLocalDb_8vN4pQ2k' SUPERUSER;");
      console.log('User "wamy" already exists, password updated.');
    } else {
      console.error('User creation error:', e.message);
    }
  }

  try {
    await client.query("CREATE DATABASE wamy_tasks OWNER wamy;");
    console.log('Database "wamy_tasks" created successfully.');
  } catch (e) {
    if (e.code === '42P04') {
      console.log('Database "wamy_tasks" already exists.');
    } else {
      console.error('Database creation error:', e.message);
    }
  }

  await client.end();
}

main().catch(console.error);
