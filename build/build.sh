#!/usr/bin/env bash
usage="usage :$0 <git user:password> <make | publish> S3_SECRET_ACCESS_KEY"
gitAuth=$1
forgeCommand=$2
s3Secret=$3


if [[ -z ${gitAuth} ]] || [[ -z ${forgeCommand} ]] || [[ -z ${s3Secret} ]]; then
	echo ${usage}
	exit 1
fi

git clone https://${gitAuth}@bitbucket.org/galusben/reversee.git
cd reversee
yarn install
export ELECTRON_FORGE_S3_SECRET_ACCESS_KEY=${s3Secret}
electron-forge --target=s3 ${forgeCommand}