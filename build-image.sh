#!/bin/bash

version=0.0.7

nvm use 10 
cd server 
npm run prepare:js
cd ..
docker build -t s3pweb/logio:$version .
docker push s3pweb/logio:$version