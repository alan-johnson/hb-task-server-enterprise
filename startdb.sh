#!/bin/bash

# start Redis server
/opt/homebrew/opt/redis/bin/redis-server

# export PATH to include PostgreSQL binaries
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# start PostgreSQL server
LC_ALL="en_US.UTF-8" /opt/homebrew/opt/postgresql@18/bin/postgres -D /opt/homebrew/var/postgresql@18