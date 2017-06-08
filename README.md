**Reversee**

A web debugger, http reverse engineering tool.

Reversee is a reverse proxy based tool that let you see http / https traffic between a client and a server.

The goal of Reversee is to let you start working / debugging with the least setup possible.

**Getting started**

 * Download and Launch the app, find the right executable depends on your OS.
 * Choose a listen protocol (http / https) and listen port (note, on most Operating Systems, in order to Listen to a small port [<1024] you will have to run Reversee with admin / root permission).
 * Choose destination protocol, destination hostname, and destination port.
 * Click the ON button, and you are good to go.
 
Reversee is now listening on the port you have selected and will transfer any data to the destination you have selected.

Test your setting: 
You can test your setting is good by running:
`curl -XGET <listen-protocol>:<linten-port>`

The above command shall create an entry in Reversee main screen.
