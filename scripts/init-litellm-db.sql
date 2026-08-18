-- Runs once, on first initialisation of the Postgres volume.
-- The portal and LiteLLM each keep their own database on the same server;
-- POSTGRES_DB creates jsan_dev_ai, this adds the second.
CREATE DATABASE litellm;
