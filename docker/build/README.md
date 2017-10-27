docker build -t forgebuilder .
docker run --name forge forgebuilder:latest bash make.sh 'user:password' publish $ELECTRON_FORGE_S3_SECRET_ACCESS_KEY
docker cp forge:/app/reversee/out/make/Reversee-linux-x64-0.0.1.zip .
docker cp forge:/app/reversee/out/make/Reversee_0.0.1_amd64.deb .
