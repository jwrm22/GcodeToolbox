# Gcode toolbox
This is a webapp that will help you generate gcode for simple operations in a fast way.

<img width="100%" alt="Gcode v2" src="https://github.com/user-attachments/assets/87435c04-079e-4ce7-971b-fc817221a78f" />


# How to use this app
This app is designed as a webpage. This was done to make it easy to run without any advanced technical knowledge and still be compatible across operating systems. To use this app simply download the .zip and extract it. Afterwards you can open the index.html with your browser. An internet connection should not be needed for this app. 
Once in the app use the parameters to choose and configure your operation and click the generate button. Afterwards you get the possibility to download the file or simply copy the gcode and open it with your machine. Enjoy!

The latest version of the web app can also be viewed [here](https://fabianoh130.github.io/GcodeToolbox/)

# Bugs or ideas?
Im still working on this project. If you encounter any bugs or have ideas for new functionality, please feel free to leave an issue and ill try to get back to you as soon as i can.

## Future plans
Things im considering doing in the future versions:
* Run this on a webserver so you guys always use the latest version
* Rounded corners on rectangles
* Circular bolt hole pattern
* Finish pass
* G2/G3 arcs
* more fluent preview


# Support this project
If you like this project and want to support me, feel free to do so via [this link](https://ko-fi.com/fabianoh130).

# Disclaimer
Always review the generated code before running it on your machine.

This project was created out of my own need for a practical toolbox, and I want to make it available for others. I am not responsible for any damage, errors, or issues caused by using this app or the code it generates. Use it at your own risk.

# Version

## V3.0
* Added advanced/simple mode
* Added Import and export settings
* Settings are now saved in localstorage so you can pick up where you left.
* Bugfixes in more complex .dxf paths 


## V2.0
* Added .dxf support (tested with .dxf's from Fusion360)
* Added hexagon to shapes
* Patterned holes shows total lenght
* Keep tool down on facing operations
* Gcode preview shows the requested shape. this makes validating the path easier.
* Added dimensions bars to all views except isometric
* Fixed letter scale bug
* Added version number to UI. Click to go to the github download page.


## V1.1
* Fixed bug where in inch mode 0.25 was not allowed
* Fixed bug where in inch mode the preview speed was slow
* Added spindle speed control upon a users request. 

## V1.0
* Multiple operation types
> * Shapes (Pocket, inner and outer contour)
> > * Circle
> > * Square
> > * Rectangle
> > * Oval
> * Facing
> * Engraving letters
> * Countersunk bolts
> * Patterned holes (with preset for Festool MFT)
* Gcode previewer that shows the toolpath in action
* Multiple origin positions
* Multiple depth cutting
* Supports both plunges and ramps
* Tabs for contour
* Light and dark theme
* Multilingual
* Mm en inch support


