FROM node:slim

COPY . /usr/scr/app
#RUN rm bdstart.sh
RUN apt-get update

# I think you need to install following
RUN apt-get -y install libgtkextra-dev libgconf2-dev libnss3 libasound2 libxtst-dev libxss1
RUN npm install --save-dev electron

RUN npm install
RUN chmod +x /usr/scr/app/start.sh

CMD ["/usr/scr/app/start.sh"]