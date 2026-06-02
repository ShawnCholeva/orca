#!/bin/bash

# 1. Set your desired time in HH:MM format
TARGET_TIME="06:11"

echo "Monitoring time... Target is $TARGET_TIME"

# 2. Loop until the current time matches the target
while [ "$(date +%H:%M)" != "$TARGET_TIME" ]; do
    sleep 1
done

# 3. Simulate the Enter key press
tmux send-keys -t claude-terminal Enter
tmux send-keys -t claude-terminal-2 Enter

echo "Enter pressed at $(date)"