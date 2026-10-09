param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("put", "get", "delete", "Exists")]
  [string]$Operation,
  [Parameter(Mandatory = $true)]
  [string]$TargetName,
  [Parameter(Mandatory = $true)]
  [string]$UserName
)

$nativeSource = @"
using System;
using System.Runtime.InteropServices;

public static class DeepAACredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public Int64 LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref Credential credential, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@

Add-Type -TypeDefinition $nativeSource
$credentialTypeGeneric = 1
$credentialPersistLocalMachine = 2

if ($Operation -eq "Exists") {
  $pointer = [IntPtr]::Zero
  $found = [DeepAACredentialNative]::CredRead($TargetName, $credentialTypeGeneric, 0, [ref]$pointer)
  if ($found) { [DeepAACredentialNative]::CredFree($pointer) }
  if ($found) { exit 0 }
  exit 1
}

if ($Operation -eq "put") {
  $secret = [Console]::In.ReadToEnd().TrimEnd("`r", "`n")
  if ([string]::IsNullOrEmpty($secret)) { throw "CREDENTIAL_SECRET_REQUIRED" }
  $bytes = [Text.Encoding]::Unicode.GetBytes($secret)
  $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $credential = New-Object DeepAACredentialNative+Credential
    $credential.Type = $credentialTypeGeneric
    $credential.TargetName = $TargetName
    $credential.CredentialBlobSize = $bytes.Length
    $credential.CredentialBlob = $blob
    $credential.Persist = $credentialPersistLocalMachine
    $credential.UserName = $UserName
    if (-not [DeepAACredentialNative]::CredWrite([ref]$credential, 0)) {
      throw "CREDENTIAL_WRITE_FAILED:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  } finally {
    for ($index = 0; $index -lt $bytes.Length; $index++) { $bytes[$index] = 0 }
    [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
    $secret = $null
  }
  exit 0
}

if ($Operation -eq "get") {
  $pointer = [IntPtr]::Zero
  if (-not [DeepAACredentialNative]::CredRead($TargetName, $credentialTypeGeneric, 0, [ref]$pointer)) {
    throw "CREDENTIAL_READ_FAILED:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $pointer,
      [type][DeepAACredentialNative+Credential]
    )
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni(
      $credential.CredentialBlob,
      [int]($credential.CredentialBlobSize / 2)
    )
    [Console]::Out.Write($secret)
  } finally {
    [DeepAACredentialNative]::CredFree($pointer)
    $secret = $null
  }
  exit 0
}

if (-not [DeepAACredentialNative]::CredDelete($TargetName, $credentialTypeGeneric, 0)) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($errorCode -ne 1168) { throw "CREDENTIAL_DELETE_FAILED:$errorCode" }
}
