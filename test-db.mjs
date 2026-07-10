import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

async function test() {
  const { data, error } = await supabase.from('orders').select('id').limit(1);
  if (error || !data.length) return console.log('No orders or error', error);
  
  const orderId = data[0].id;
  const { error: updateError } = await supabase.from('orders').update({ status: 'delivered' }).eq('id', orderId);
  if (updateError) {
    console.log('Constraint error:', updateError.message);
  } else {
    console.log('Success, no constraint');
    await supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId); // revert
  }
}
test();
