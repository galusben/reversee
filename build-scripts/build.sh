#!/usr/bin/env bash
usage="usage :$0 <git user:password> <dist | release> AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"
gitAuth=$1
command=$2
s3id=$3
s3Secret=$4


if [[ -z ${gitAuth} ]] || [[ -z ${command} ]] || [[ -z ${s3Secret} ]] || [[ -z ${s3id} ]]; then
	echo ${usage}
	exit 1
fi

git clone https://${gitAuth}@bitbucket.org/galusben/reversee.git
cd reversee
yarn install
export AWS_ACCESS_KEY_ID=${s3id}
export AWS_SECRET_ACCESS_KEY=${s3Secret}
yarn ${command}