import tkinter as tk

root = tk.Tk()
root.title("Tkinter 计数器")
count = 0

label = tk.Label(root, text="计数: 0")
label.pack()


def on_add():
    global count
    count += 1
    label.config(text="已点击")


def on_reset():
    global count
    count = 0
    label.config(text="已重置")


btn_add = tk.Button(root, text="加一", command=on_add)
btn_add.pack()
btn_reset = tk.Button(root, text="重置", command=on_reset)
btn_reset.pack()

root.mainloop()
