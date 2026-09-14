import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

async function test() {
  const { data, error } = await supabase
    .from('orders')
    .upsert({
      id: 'store_state_001',
      items: [],
      total_price: 0,
      customer_name: 'STORE_STATE',
      status: 'cancelled',
      order_number: '0000',
      // We can use customer_avatar to store stringified JSON state
      customer_avatar: JSON.stringify({ isManualOpen: true, date: '2026-09-14' })
    })
    .select();
  console.log('Result:', data, error);
}
test();
