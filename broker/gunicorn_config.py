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
# workers need no coordination beyond the host. flask-limiter's counters do
# NOT: with the default memory:// storage each worker counts separately, so
# the effective rate limits are the stated limits times this worker count
# (set RATELIMIT_STORAGE_URI to share counters — see broker/README.md).
workers = 2

# Request log to stdout, so the service manager captures it.
accesslog = "-"
