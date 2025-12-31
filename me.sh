#!/bin/bash

echo "Stopping komari-agent..."
systemctl stop komari-agent 2>/dev/null

echo "Disabling komari-agent..."
systemctl disable komari-agent 2>/dev/null

echo "Removing systemd service files..."
rm -f /etc/systemd/system/komari-agent.service
rm -rf /etc/systemd/system/komari-agent.service.d

echo "Reloading systemd..."
systemctl daemon-reload
systemctl reset-failed

echo "Removing komari agent files..."
rm -rf /opt/komari
rm -rf /etc/komari-agent
rm -rf /var/lib/komari-agent
rm -rf /var/log/komari-agent*

echo "Checking remaining komari units..."
systemctl list-unit-files | grep -i komari || echo "No komari units found."

echo "Komari Agent cleanup completed."
