#!/bin/bash

#export PATH="/opt/homebrew/var/postgresql@18:$PATH"
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
LC_ALL="en_US.UTF-8" /opt/homebrew/opt/postgresql@18/bin/postgres -D /opt/homebrew/var/postgresql@18