import { rootCertificates } from 'node:tls';

// Official provider CA, downloaded over HTTPS. SHA-256:
// 807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA
// https://supabase-downloads.s3.amazonaws.com/prod/ssl/prod-ca-2021.crt
const SUPABASE_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;

export function databaseUrlFromEnv(env: Record<string, string | undefined>) {
  const value = [
    env.DATABASE_URL,
    env.POSTGRES_URL_NON_POOLING,
    env.POSTGRES_URL,
    env.POSTGRES_PRISMA_URL,
  ]
    .find((value) => value?.trim())
    ?.trim();
  if (!value)
    throw new Error(
      'Set DATABASE_URL or POSTGRES_URL_NON_POOLING for the user database.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The user database requires a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('The user database requires a valid PostgreSQL URL.');
  return value;
}

export function postgresConnectionOptions(connectionString: string) {
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local) return { connectionString: url.toString() };
  const supabase =
    /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) ||
    /^db\.[a-z0-9]+\.supabase\.co$/.test(url.hostname);
  // Explicit certificate files remain supported. Otherwise trust Supabase's CA
  // alongside normal public roots without weakening chain or hostname checks.
  if (
    supabase &&
    !['sslrootcert', 'sslcert', 'sslkey'].some((key) =>
      url.searchParams.has(key),
    )
  ) {
    for (const key of ['sslmode', 'ssl', 'uselibpqcompat'])
      url.searchParams.delete(key);
    return {
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true, ca: [...rootCertificates, SUPABASE_CA] },
    };
  }
  url.searchParams.set('sslmode', 'verify-full');
  return { connectionString: url.toString() };
}
