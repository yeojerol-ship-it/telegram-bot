import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL or SUPABASE_ANON_KEY is not set in .env');
}

export const supabase = createClient(url, key);
