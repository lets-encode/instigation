# Gunicorn settings for the session broker. Run from broker/:
#
#   PORT=7777 gunicorn -c gunicorn_config.py wsgi:app
#
# One broker process per instance; PORT must match the instance's Apache
# ProxyPass target (production 7777, staging 7778, testing 7779 — see
# deploy/). Loopback only: the reverse proxy is the broker's sole client.
import os

bind = "127.0.0.1:" + os.environ.get("PORT", "7777")

# Sessions and the slug DB live on the shared filesystem (instance/), so
# workers need no coordination beyond the host.
workers = 2

# Request log to stdout, so the service manager captures it.
accesslog = "-"
