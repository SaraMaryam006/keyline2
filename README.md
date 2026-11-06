# Keyline Property & Tenant Management (Netlify version)
Website + staff portal + serverless backend (Netlify Function + Netlify Blobs), all on Netlify.
- public/index.html  website        - public/app.html  staff portal (login: admin@keyline.org / Admin@123)
- netlify/functions/api.mjs  backend API (auth, properties, tenants, payments, requests, stats, enquiries)
- netlify.toml, package.json  build settings
Deploy: push to GitHub, then Netlify > Add new site > Import an existing project. Add env var JWT_SECRET.
