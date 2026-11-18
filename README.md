# AI Sales Bot

কাস্টমারের সাথে পণ্য আলোচনা, দরদাম (min_price পর্যন্ত) ও অটো অর্ডার।

## চালানো
1. `npm install`
2. `.env.example` কপি করে `.env` বানান, কী গুলো বসান
3. `products.json`-এ পণ্য দিন (`price` = শুরুর দাম, `min_price` = সর্বনিম্ন দাম)
4. `npm start`

## চ্যানেল যুক্ত করা
- **Messenger / Instagram / WhatsApp:** Meta Developer-এ Webhook URL = `https://আপনার-ডোমেইন/webhook/meta`, Verify Token = `.env`-এর `META_VERIFY_TOKEN`। Subscribe: messages। HTTPS বাধ্যতামূলক (ngrok/Render/VPS)।
- **ওয়েবসাইট:** পেজে `<script src="https://আপনার-ডোমেইন/widget.js"></script>` বসান।

## অর্ডার
- `WOO_*` দিলে WooCommerce-এ অর্ডার হবে; `ORDER_WEBHOOK_URL` দিলে যেকোনো সাইটে JSON POST (`X-Signature` = HMAC-SHA256)। সব অর্ডার `orders.jsonl`-এও জমা হয়।

## নিরাপত্তা নকশা
- `min_price` AI-কে কখনো দেখানো হয় না; দাম ও অর্ডারের সিদ্ধান্ত কোডে যাচাই হয়, তাই prompt-injection দিয়ে কম দামে কেনা যায় না।
- প্রোডাকশনের আগে: sessions Redis/DB-তে নিন, স্টক কমানোর লজিক যোগ করুন, লগ ও মনিটরিং রাখুন।
