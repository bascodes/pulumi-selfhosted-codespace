#!/usr/bin/env sh

sudo -u $USER_NAME ssh-keygen -t ed25519 -f /ssh-user/sshd_host_key -N "" &&
    sudo -u $USER_NAME /usr/sbin/sshd -D -e -p $SSH_PORT -f /dev/null -o PidFile=/ssh-user/sshd.pid -o PermitRootLogin=no -o PasswordAuthentication=no -o PubkeyAuthentication=yes -o AuthorizedKeysFile=/ssh-user/authorized_keys -o HostKey=/ssh-user/sshd_host_key -o Subsystem='sftp internal-sftp' &
ssh -o ServerAliveInterval=60 -o ServerAliveCountMax=9999999 -o IdentityFile=/ssh-user/id -o StrictHostKeyChecking=accept-new root@$REMOTE_HOST -R $SSH_PORT:localhost:$SSH_PORT \
    "sshfs -o ServerAliveInterval=60 -o ServerAliveCountMax=9999999 -o StrictHostKeyChecking=accept-new  -o IdentityFile=/root/id -p $SSH_PORT $USER_NAME@localhost:/workspace /workspace; sleep infinity" &
sleep infinity
