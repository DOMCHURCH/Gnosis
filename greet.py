"""A very simple Python script."""

import datetime

name = input("What is your name? ")
now = datetime.datetime.now()

print(f"\nHello {name}! The time is {now.strftime('%I:%M %p')} on {now.strftime('%A, %B %d, %Y')}.")
print("Have a great day!")