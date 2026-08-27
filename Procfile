web: cd web/landing && npm install && npm run build
api: cd pipeline && gunicorn server:app -b 0.0.0.0:$PORT -w 1 --threads 4 --timeout 120
