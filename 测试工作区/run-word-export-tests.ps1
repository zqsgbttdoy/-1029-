param(
    [Parameter(Mandatory = $true)][string]$Backend,
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$Scope = "test"
)

# Scope=test : run only SafetyLogWordExportTest
# Scope=all  : full backend regression
$ErrorActionPreference = "Continue"
$mvn = Join-Path $Backend ".mvn\maven\apache-maven-3.9.6\bin\mvn.cmd"
$env:JAVA_TOOL_OPTIONS = "-Dfile.encoding=UTF-8"

Push-Location $Backend
try {
    if ($Scope -eq "all") {
        & $mvn -o -B "-Dmaven.repo.local=$Repo" test
    }
    else {
        & $mvn -o -B "-Dmaven.repo.local=$Repo" "-Dtest=SafetyLogWordExportTest" "-Dsurefire.failIfNoSpecifiedTests=false" test
    }
}
finally {
    Pop-Location
}
