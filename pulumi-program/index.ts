import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as docker from "@pulumi/docker";
import * as hcloud from "@pulumi/hcloud";
import { buildVsCodeRemoteUrl } from "vscode-url";

const config = new pulumi.Config();
const hcloudToken = config.requireSecret("hcloudToken");

const sshdPort = config.requireNumber("sshdPort");
const userName = config.require("userName");
const userUid = config.requireNumber("userUid");
const userGid = config.requireNumber("userGid");
const userPublicKeyPath = config.require("userPublicKeyPath");
const userPrivateKeyPath = config.require("userPrivateKeyPath");
const localDockerHost = config.require("localDockerHost");
const workspaceExportDirectory = config.require("workspaceExportDirectory");
const devcontainerConfigPath = config.require("devcontainerConfigPath");
const hCloudServerSpec = {
  serverType: config.require("hcloudServerType"),
  image: "ubuntu-22.04",
  location: config.require("hcloudServerLocation"),
};

const userPublicKey = pulumi.secret(
  require("fs").readFileSync(userPublicKeyPath).toString()
);
const userPrivateKey = pulumi.secret(
  require("fs").readFileSync(userPrivateKeyPath).toString()
);
const hcloudProvider = new hcloud.Provider("hcloud-provider", {
  token: hcloudToken,
});
const dockerProviderLocal = new docker.Provider("docker-provider-local", {
  host: localDockerHost,
});

const dockerImageSshSidecar = new docker.Image(
  "ssh-sidecar-image",
  {
    imageName: "ssh-sidecar-image",
    build: {
      context: "./ssh-sidecar",
      dockerfile: "./ssh-sidecar/Dockerfile",
      args: {
        USER_NAME: userName,
        USER_UID: `${userUid}`,
        USER_GID: `${userGid}`,
      },
    },
    skipPush: true,
  },
  { provider: dockerProviderLocal }
);

const serverSshKey = new hcloud.SshKey(
  "user-ssh-key",
  { publicKey: userPublicKey },
  { provider: hcloudProvider }
);

const server = new hcloud.Server(
  "docker-server",
  {
    ...hCloudServerSpec,
    sshKeys: [serverSshKey.name],
  },
  { provider: hcloudProvider, dependsOn: serverSshKey }
);

const setupServerCommand = new command.remote.Command(
  "setup-server",
  {
    connection: {
      host: server.ipv4Address,
      user: "root",
      privateKey: userPrivateKey,
    },
    create: `apt-get update && apt-get install -y curl ca-certificates sshfs
    
        apt-get update
        apt-get install -y ca-certificates curl
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        
        echo \
          "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
          $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
          tee /etc/apt/sources.list.d/docker.list > /dev/null
        apt-get update
    
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        systemctl enable docker
        systemctl start docker
        
        mkdir -p /workspace`,
  },
  { dependsOn: server }
);

const localSshHostReset = new command.local.Command(
  "local-ssh-host-key-clearing",
  {
    create: pulumi.interpolate`sleep 30 && \
     ssh-keygen -R ${server.ipv4Address} >/dev/null 2>&1 || true 
     ssh -o StrictHostKeyChecking=accept-new root@${server.ipv4Address} echo "SSH connection established."`,
  },
  { dependsOn: server }
);

const copyPrivateKeyToServer = new command.remote.CopyToRemote(
  "copy-private-key-to-server",
  {
    connection: {
      host: server.ipv4Address,
      user: "root",
      privateKey: userPrivateKey,
    },
    remotePath: "/root/id",
    source: new pulumi.asset.FileAsset(userPrivateKeyPath),
  },
  { dependsOn: [server, localSshHostReset] }
);

const copyPublicKeyToServer = new command.remote.CopyToRemote(
  "copy-public-key-to-server",
  {
    connection: {
      host: server.ipv4Address,
      user: "root",
      privateKey: userPrivateKey,
    },
    remotePath: "/root/id.pub",
    source: new pulumi.asset.FileAsset(userPublicKeyPath),
  },
  { dependsOn: [server, localSshHostReset] }
);

const fixPrivateKeyPermissionsOnServer = new command.remote.Command(
  "fix-private-key-permissions-on-server",
  {
    connection: {
      host: server.ipv4Address,
      user: "root",
      privateKey: userPrivateKey,
    },
    create: `chmod 600 /root/id`,
  },
  { dependsOn: [copyPrivateKeyToServer, copyPublicKeyToServer] }
);

const establishSshfsMount = new docker.Container(
  "establish-sshfs-mount",
  {
    image: dockerImageSshSidecar.imageName,
    restart: "unless-stopped",
    volumes: [
      { containerPath: "/workspace", hostPath: workspaceExportDirectory },
      {
        containerPath: "/ssh-user/authorized_keys",
        hostPath: userPublicKeyPath,
      },
      {
        containerPath: "/ssh-user/id",
        hostPath: userPrivateKeyPath,
      },
    ],
    envs: [
      `SSH_PORT=${sshdPort}`,
      pulumi.interpolate`REMOTE_HOST=${server.ipv4Address}`,
      `USER_NAME=${userName}`,
    ],
  },
  {
    dependsOn: [
      fixPrivateKeyPermissionsOnServer,
      setupServerCommand,
      dockerImageSshSidecar,
    ],
    provider: dockerProviderLocal,
  }
);

const devcontainerUp = new command.local.Command(
  "devcontainer-up",
  {
    environment: {
      DOCKER_HOST: pulumi.interpolate`ssh://root@${server.ipv4Address}`,
    },
    create: `devcontainer up \
      --config ${devcontainerConfigPath} \
      --id-label "pulumi-stack=hcloud-demo" \
      --workspace-folder "/tmp/"`,
  },
  { dependsOn: [localSshHostReset, establishSshfsMount] }
);

const devcontainerOpen = new command.local.Command(
  "devcontainer-open",
  {
    create: devcontainerUp.stdout.apply((stdout) => {
      const vsCodeUrl = buildVsCodeRemoteUrl(
        JSON.parse(stdout).containerId,
        "/workspace"
      );

      return `echo vscode-remote://attached-container+${vsCodeUrl.hex}/workspace
      code --folder-uri=vscode-remote://attached-container+${vsCodeUrl.hex}/workspace`;
    }),
    environment: {
      DOCKER_HOST: pulumi.interpolate`ssh://root@${server.ipv4Address}`,
    },
  },
  { dependsOn: devcontainerUp }
);

export const serverIp = server.ipv4Address;
export const devcontainerupOutput = devcontainerUp.stdout;
export const devcontainerOpenOutput = devcontainerOpen.stdout;
export const sshTunnelContainerId = establishSshfsMount.id;
export const vsCodeUrl = devcontainerOpen.stdout;
