// ============================================================
// Remote Control Device Key Enrollment — 从 main.js 反编译重建
// 7 步握手 + Secure Enclave ECDSA P-256 认证
// ============================================================

import { createHash, randomUUID } from "node:crypto";

// --- Zod Schema（从 main.js 验证逻辑还原）---

/**
 * Device Key Challenge 的 Zod schema
 * Server 在 enrollment/start 响应中返回
 */
const DeviceKeyChallengeSchema = {
  type: "device_key_challenge" as const,
  nonce: "string (min 1, base64url)",
  purpose: "remote_control_client_enrollment" as const,
  audience: "remote_control_client_enrollment" as const,
  challenge_id: "string (min 1)",
  target_origin: "string (min 1)",
  target_path: "string (min 1)",
  account_user_id: "string (min 1)",
  client_id: "string (min 1)",
  challenge_token: "string (min 1)",
  device_identity_hash: "string (nullable, optional)",
  challenge_expires_at: "number (timestamp)",
};

// --- 类型定义 ---

interface DesktopApiOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

interface DeviceKeyClient {
  createDeviceKey(
    accountUserId: string,
    clientId: string,
    protectionClass: string
  ): Promise<DeviceKey>;
  getDeviceKeyPublic(keyId: string): Promise<string>;
  signDeviceKey(
    keyId: string,
    payload: Record<string, unknown>
  ): Promise<DeviceKeySignature>;
  deleteDeviceKey(keyId: string): Promise<void>;
}

interface DeviceKey {
  accountUserId: string;
  algorithm: "ecdsa_p256_sha256";
  clientId: string;
  keyId: string;
  protectionClass: "hardware_secure_enclave" | "os_protected_nonextractable";
  publicKeySpkiDerBase64: string;
}

interface DeviceKeySignature {
  algorithm: "ecdsa_p256_sha256";
  signatureDerBase64: string;
  signedPayloadBase64: string;
}

interface EnrollmentState {
  accountUserId: string;
  algorithm: string;
  clientId: string;
  keyId: string;
  protectionClass: string;
  publicKeySpkiDerBase64: string;
}

interface DeviceKeyChallenge {
  type: "device_key_challenge";
  nonce: string;
  purpose: string;
  audience: string;
  challenge_id: string;
  target_origin: string;
  target_path: string;
  account_user_id: string;
  client_id: string;
  challenge_token: string;
  device_identity_hash?: string | null;
  challenge_expires_at: number;
}

interface DeviceKeyProof {
  challenge_token: string;
  key_id: string;
  signature_der_base64: string;
  signed_payload_base64: string;
  algorithm: "ecdsa_p256_sha256";
}

interface DeviceIdentity {
  key_id: string;
  public_key_spki_der_base64: string;
  algorithm: string;
  protection_class: string;
}

// --- Enrollment Key ---

/**
 * 生成 enrollment key
 * 格式: "remote_control_client_enrollment:{desktopApiBaseUrl}:{accountUserId}"
 */
function makeEnrollmentKey(
  desktopApiOptions: DesktopApiOptions,
  accountUserId: string
): string {
  return `remote_control_client_enrollment:${desktopApiOptions.baseUrl}:${accountUserId}`;
}

/**
 * 从 enrollment key 解析 accountUserId
 */
function parseEnrollmentKey(key: string, accountUserId: string): string {
  return key; // key 包含 accountUserId，用于查找
}

// --- 设备身份 ---

/**
 * 构建设备身份对象
 */
function buildDeviceIdentity(key: DeviceKey): DeviceIdentity {
  return {
    key_id: key.keyId,
    public_key_spki_der_base64: key.publicKeySpkiDerBase64,
    algorithm: key.algorithm,
    protection_class: key.protectionClass,
  };
}

/**
 * 计算设备身份 hash
 * SHA256(JSON.stringify(DeviceIdentity)) → base64url
 */
function computeDeviceIdentityHash(identity: DeviceIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        algorithm: identity.algorithm,
        keyId: identity.key_id,
        protectionClass: identity.protection_class,
        publicKeySpkiDerBase64: identity.public_key_spki_der_base64,
      })
    )
    .digest("base64url");
}

// --- Challenge 验证 ---

/**
 * 验证 challenge 与本地 enrollment 的一致性
 */
function validateChallengeMatch(
  challenge: DeviceKeyChallenge,
  enrollment: DeviceKey,
  expectedTargetOrigin: string,
  expectedTargetPath: string,
  requireDeviceIdentityHash: boolean
): void {
  if (
    challenge.account_user_id !== enrollment.accountUserId ||
    challenge.client_id !== enrollment.clientId ||
    challenge.target_origin !== expectedTargetOrigin ||
    challenge.target_path !== expectedTargetPath
  ) {
    throw new Error(
      "Remote control enrollment challenge does not match local enrollment."
    );
  }

  if (requireDeviceIdentityHash && challenge.device_identity_hash == null) {
    throw new Error(
      "Remote control enrollment challenge is missing device identity hash."
    );
  }

  const identityHash = challenge.device_identity_hash
    ?? computeDeviceIdentityHash(buildDeviceIdentity(enrollment));

  if (identityHash !== computeDeviceIdentityHash(buildDeviceIdentity(enrollment))) {
    throw new Error(
      "Remote control enrollment challenge does not match local device identity."
    );
  }
}

// --- 签名 ---

/**
 * 用 Device Key 签名 enrollment challenge
 */
async function signEnrollmentChallenge(
  challenge: DeviceKeyChallenge,
  deviceKeyClient: DeviceKeyClient,
  enrollment: DeviceKey,
  expectedOrigin: string,
  expectedPath: string,
  requireHash: boolean
): Promise<DeviceKeyProof> {
  validateChallengeMatch(
    challenge, enrollment, expectedOrigin, expectedPath, requireHash
  );

  const identityHash = challenge.device_identity_hash
    ?? computeDeviceIdentityHash(buildDeviceIdentity(enrollment));

  const signature = await deviceKeyClient.signDeviceKey(enrollment.keyId, {
    type: "remoteControlClientEnrollment",
    nonce: challenge.nonce,
    audience: challenge.audience,
    challengeId: challenge.challenge_id,
    targetOrigin: challenge.target_origin,
    targetPath: challenge.target_path,
    accountUserId: challenge.account_user_id,
    clientId: challenge.client_id,
    deviceIdentitySha256Base64url: identityHash,
    challengeExpiresAt: challenge.challenge_expires_at,
  });

  return {
    challenge_token: challenge.challenge_token,
    key_id: enrollment.keyId,
    signature_der_base64: signature.signatureDerBase64,
    signed_payload_base64: signature.signedPayloadBase64,
    algorithm: signature.algorithm,
  };
}

// --- Enrollment 主流程 ---

/**
 * 7 步 Device Key Enrollment 完整流程
 */
async function enrollDevice({
  appServerClient,
  deviceKeyClient,
  desktopApiOptions,
  enrollmentKey,
  globalState,
  headers,
  requestRemoteControlEnrollmentStepUpToken,
}: {
  appServerClient: AppServerClient;
  deviceKeyClient: DeviceKeyClient;
  desktopApiOptions: DesktopApiOptions;
  enrollmentKey: string;
  globalState: GlobalState;
  headers: Record<string, string>;
  requestRemoteControlEnrollmentStepUpToken: () => Promise<string>;
}): Promise<void> {
  const accountUserId = parseEnrollmentKey(enrollmentKey, "");
  const authIdentity = getAuthIdentity(globalState);

  // Step 1: 检查现有 enrollment
  const existingEnrollment = getExistingEnrollment(globalState, enrollmentKey);

  if (existingEnrollment == null) {
    // === 新 Enrollment ===

    // Step 2: POST /enroll/start → challenge
    const startResponse = await appServerClient.post(
      "/codex/remote/control/client/enroll/start",
      { body: {}, desktopApiOptions, headers }
    );

    // Step 3: 验证 challenge 中的 account_user_id 匹配
    if (startResponse.account_user_id !== accountUserId) {
      throw new Error(
        "Remote control enrollment start does not match current account."
      );
    }

    // Step 4: 创建设备密钥 (Secure Enclave)
    const deviceKey = await deviceKeyClient.createDeviceKey(
      accountUserId,
      startResponse.client_id,
      "hardware_secure_enclave"
    );

    // Step 5: Step-Up 认证 (重新验证用户)
    const stepUpToken = await requestRemoteControlEnrollmentStepUpToken();

    // Step 6: 签名 challenge
    const proof = await signEnrollmentChallenge(
      startResponse.device_key_challenge,
      deviceKeyClient,
      deviceKey,
      `${desktopApiOptions.baseUrl}`,
      "/codex/remote/control/client/enroll/finish",
      false
    );

    // Step 7: POST /enroll/finish
    const finishResponse = await appServerClient.post(
      "/codex/remote/control/client/enroll/finish",
      {
        body: {
          client_id: deviceKey.clientId,
          step_up_token: stepUpToken,
          device_identity: buildDeviceIdentity(deviceKey),
          device_key_proof: proof,
        },
        desktopApiOptions,
        headers,
      }
    );

    // 持久化 enrollment
    saveEnrollment(globalState, enrollmentKey, {
      accountUserId: deviceKey.accountUserId,
      algorithm: deviceKey.algorithm,
      clientId: deviceKey.clientId,
      keyId: deviceKey.keyId,
      protectionClass: deviceKey.protectionClass,
      publicKeySpkiDerBase64: deviceKey.publicKeySpkiDerBase64,
    });

  } else {
    // === Refresh 现有 Enrollment ===

    try {
      const refreshResponse = await appServerClient.post(
        "/codex/remote/control/client/refresh",
        {
          body: { client_id: existingEnrollment.clientId },
          desktopApiOptions,
          headers,
        }
      );
      // 更新 token...
    } catch (error) {
      // 如果 refresh 失败（非 401），清理旧 enrollment 并重新开始
      if (!isUnauthorizedError(error)) throw error;
      await deviceKeyClient.deleteDeviceKey(existingEnrollment.keyId);
      removeEnrollment(globalState, enrollmentKey);

      // 递归重新开始 enrollment
      return enrollDevice({
        appServerClient, deviceKeyClient, desktopApiOptions,
        enrollmentKey, globalState, headers,
        requestRemoteControlEnrollmentStepUpToken,
      });
    }
  }
}

// --- 辅助函数 ---

/**
 * 签名 WebSocket Connection challenge
 */
async function signConnectionChallenge(
  challenge: DeviceKeyChallenge,
  deviceKeyClient: DeviceKeyClient,
  enrollment: DeviceKey,
  tokenSha256: string
): Promise<DeviceKeyProof> {
  const signature = await deviceKeyClient.signDeviceKey(enrollment.keyId, {
    type: "remoteControlClientConnection",
    nonce: challenge.nonce,
    audience: "remote_control_client_websocket",
    scopes: ["remote_control_controller_websocket"],
    sessionId: challenge.challenge_id,
    targetOrigin: challenge.target_origin,
    targetPath: challenge.target_path,
    tokenExpiresAt: challenge.challenge_expires_at,
    tokenSha256Base64url: tokenSha256,
    accountUserId: challenge.account_user_id,
    clientId: challenge.client_id,
  });

  return {
    challenge_token: challenge.challenge_token,
    key_id: enrollment.keyId,
    signature_der_base64: signature.signatureDerBase64,
    signed_payload_base64: signature.signedPayloadBase64,
    algorithm: signature.algorithm,
  };
}

// --- 占位接口 ---

interface AppServerClient {
  post(path: string, options: unknown): Promise<Record<string, unknown>>;
}

interface GlobalState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

function getAuthIdentity(state: GlobalState): unknown { return state.get("auth"); }
function getExistingEnrollment(state: GlobalState, key: string): EnrollmentState | null {
  return state.get(key) as EnrollmentState | null;
}
function saveEnrollment(state: GlobalState, key: string, enrollment: EnrollmentState): void {
  state.set(key, enrollment);
}
function removeEnrollment(state: GlobalState, key: string): void {
  state.set(key, null);
}
function isUnauthorizedError(error: unknown): boolean {
  return (error as { status?: number })?.status === 401;
}

export {
  enrollDevice,
  signEnrollmentChallenge,
  signConnectionChallenge,
  buildDeviceIdentity,
  computeDeviceIdentityHash,
  makeEnrollmentKey,
};

export type {
  DeviceKey,
  DeviceKeyClient,
  DeviceKeyChallenge,
  DeviceKeyProof,
  DeviceIdentity,
  EnrollmentState,
  DesktopApiOptions,
};
