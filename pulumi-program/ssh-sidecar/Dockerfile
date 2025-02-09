FROM debian:bookworm-slim

ARG USER_NAME="vscode"
ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update && apt-get install -y \
    openssh-server \
    openssh-client \
    sudo \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid ${USER_GID} ${USER_NAME} && useradd -m -s /bin/bash -u ${USER_UID} -g ${USER_GID} ${USER_NAME}

RUN mkdir /ssh && mkdir /ssh-user && chown ${USER_NAME} /ssh-user

COPY entrypoint.sh /entrypoint.sh

ENTRYPOINT [ "/entrypoint.sh" ]