FROM malept/electron-forge-container:latest
WORKDIR /app
RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add -
RUN echo "deb https://dl.yarnpkg.com/debian/ stable main" | sudo tee /etc/apt/sources.list.d/yarn.list
RUN sudo apt-get update && sudo apt-get install yarn
RUN yarn global add electron-forge
RUN echo 'git clone https://$1@bitbucket.org/galusben/reversee.git\ncd reversee \nyarn install \nexport ELECTRON_FORGE_S3_SECRET_ACCESS_KEY=$3 \nelectron-forge --target=s3 $2' > make.sh
RUN cat make.sh